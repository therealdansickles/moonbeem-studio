// Manual trigger for the daily creator-earnings calculation.
//
// For every active partner_title_rate, look up the partner's title's
// active fan_edits, compute the view delta since the most recent
// PRIOR-day calculation for that fan_edit, and write a creator_earnings
// row at today's date. Idempotent within a UTC day via the unique
// (creator_id, fan_edit_id, calculation_date) index — re-running
// upserts the same row.
//
// Anti-fraud (NOT v1): future work should restrict payouts to view
// counts stable for ≥7 days, so a first-day spike doesn't accrue
// the full earnings. v1 trusts upstream view counts as-of-now.
//
// super_admin gated so we don't accidentally double-trigger from a
// page click. Cron-based scheduling is a follow-up.

import { NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/dal";
import { createServiceRoleClient } from "@/lib/supabase/service";

type PartnerRate = {
  partner_id: string;
  title_id: string;
  rate_cents_per_thousand: number;
};

type FanEdit = {
  id: string;
  creator_id: string | null;
  view_count: number;
};

type EarningsInsert = {
  creator_id: string;
  fan_edit_id: string;
  partner_id: string;
  title_id: string;
  views_at_calculation: number;
  earnings_cents: number;
  calculation_date: string;
  claimed: boolean;
};

export async function POST() {
  await requireSuperAdmin();
  const supabase = createServiceRoleClient();
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC

  const { data: rates, error: ratesErr } = await supabase
    .from("partner_title_rates")
    .select("partner_id, title_id, rate_cents_per_thousand")
    .is("deleted_at", null);
  if (ratesErr) {
    return NextResponse.json({ error: ratesErr.message }, { status: 500 });
  }
  const activeRates = (rates ?? []) as PartnerRate[];
  if (activeRates.length === 0) {
    return NextResponse.json({
      ok: true,
      titles_processed: 0,
      rows_upserted: 0,
      total_earnings_cents: 0,
      note: "no active partner_title_rates",
    });
  }

  let titlesProcessed = 0;
  let rowsUpserted = 0;
  let totalEarningsCents = 0;
  const errors: string[] = [];

  for (const rate of activeRates) {
    titlesProcessed += 1;

    const { data: edits, error: editsErr } = await supabase
      .from("fan_edits")
      .select("id, creator_id, view_count")
      .eq("title_id", rate.title_id)
      .eq("view_tracking_status", "active")
      .not("creator_id", "is", null);
    if (editsErr) {
      errors.push(`title ${rate.title_id}: ${editsErr.message}`);
      continue;
    }
    const fanEdits = (edits ?? []) as FanEdit[];
    if (fanEdits.length === 0) continue;

    // Prior view counts: most recent calculation BEFORE today per
    // fan_edit. Pull all prior rows once and reduce in JS — the
    // dataset is small enough that one query is fine.
    const fanEditIds = fanEdits.map((e) => e.id);
    const { data: priorRows, error: priorErr } = await supabase
      .from("creator_earnings")
      .select("fan_edit_id, calculation_date, views_at_calculation")
      .in("fan_edit_id", fanEditIds)
      .lt("calculation_date", today)
      .order("calculation_date", { ascending: false });
    if (priorErr) {
      errors.push(`title ${rate.title_id} prior: ${priorErr.message}`);
      continue;
    }
    const priorByEdit = new Map<string, number>();
    for (const row of priorRows ?? []) {
      const fid = row.fan_edit_id as string;
      if (!priorByEdit.has(fid)) {
        priorByEdit.set(fid, (row.views_at_calculation as number) ?? 0);
      }
    }

    // is_stub lookup so we can mark claimed on the inserted rows.
    const creatorIds = Array.from(
      new Set(fanEdits.map((e) => e.creator_id).filter((id): id is string => !!id)),
    );
    const stubByCreator = new Map<string, boolean>();
    if (creatorIds.length > 0) {
      const { data: creators } = await supabase
        .from("creators")
        .select("id, is_stub")
        .in("id", creatorIds);
      for (const c of creators ?? []) {
        stubByCreator.set(c.id as string, !!c.is_stub);
      }
    }

    const inserts: EarningsInsert[] = [];
    for (const edit of fanEdits) {
      if (!edit.creator_id) continue;
      const priorViews = priorByEdit.get(edit.id) ?? 0;
      const currentViews = edit.view_count ?? 0;
      const deltaViews = Math.max(0, currentViews - priorViews);
      const earnings = Math.floor(
        (deltaViews / 1000) * rate.rate_cents_per_thousand,
      );
      const claimed = !(stubByCreator.get(edit.creator_id) ?? true);
      inserts.push({
        creator_id: edit.creator_id,
        fan_edit_id: edit.id,
        partner_id: rate.partner_id,
        title_id: rate.title_id,
        views_at_calculation: currentViews,
        earnings_cents: earnings,
        calculation_date: today,
        claimed,
      });
      totalEarningsCents += earnings;
    }
    if (inserts.length === 0) continue;

    // Upsert on the unique (creator_id, fan_edit_id, calculation_date).
    const { error: upsertErr } = await supabase
      .from("creator_earnings")
      .upsert(inserts, {
        onConflict: "creator_id,fan_edit_id,calculation_date",
      });
    if (upsertErr) {
      errors.push(`title ${rate.title_id} upsert: ${upsertErr.message}`);
      continue;
    }
    rowsUpserted += inserts.length;
  }

  return NextResponse.json({
    ok: errors.length === 0,
    titles_processed: titlesProcessed,
    rows_upserted: rowsUpserted,
    total_earnings_cents: totalEarningsCents,
    calculation_date: today,
    errors: errors.length > 0 ? errors : undefined,
  });
}
