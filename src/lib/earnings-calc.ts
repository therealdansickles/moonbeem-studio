// Per-(partner, title) earnings calculation.
//
// Extracted from /api/admin/earnings/calculate so the same logic
// runs both from the daily admin trigger (loops over every active
// rate) and inline after a partner-admin saves a CPM rate (single
// rate scope, lets the partner see updated earnings without a
// separate ops step).
//
// Idempotent: the upsert is keyed on
// (creator_id, fan_edit_id, calculation_date) so re-running for the
// same UTC day overwrites today's row with the latest view counts.

import type { SupabaseClient } from "@supabase/supabase-js";

export type Rate = {
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

export type RateCalcResult = {
  rows_upserted: number;
  total_earnings_cents: number;
  error?: string;
};

export async function calculateEarningsForRate(
  supabase: SupabaseClient,
  rate: Rate,
  today: string,
): Promise<RateCalcResult> {
  // deleted_at IS NULL is required: pre-existing duplicate rows
  // exist on Erupcja and were soft-deleted in 20260509000006. Without
  // this filter, earnings calc credits both rows of each duplicate
  // pair (which is exactly the over-credit cleaned up by
  // 20260509000007). Defense-in-depth: the (title_id, post_id)
  // unique index prevents new duplicates; this filter prevents
  // earnings on whatever soft-deletes appear in the future.
  const { data: edits, error: editsErr } = await supabase
    .from("fan_edits")
    .select("id, creator_id, view_count")
    .eq("title_id", rate.title_id)
    .eq("is_active", true)
    // publicly readable edits only (see audit 2026-05-16)
    .in("verification_status", ["auto_verified", "approved"])
    .is("deleted_at", null)
    .not("creator_id", "is", null);
  if (editsErr) {
    return { rows_upserted: 0, total_earnings_cents: 0, error: editsErr.message };
  }
  const fanEdits = (edits ?? []) as FanEdit[];
  if (fanEdits.length === 0) {
    return { rows_upserted: 0, total_earnings_cents: 0 };
  }

  const fanEditIds = fanEdits.map((e) => e.id);
  const { data: priorRows, error: priorErr } = await supabase
    .from("creator_earnings")
    .select("fan_edit_id, calculation_date, views_at_calculation")
    .in("fan_edit_id", fanEditIds)
    .lt("calculation_date", today)
    .order("calculation_date", { ascending: false });
  if (priorErr) {
    return { rows_upserted: 0, total_earnings_cents: 0, error: priorErr.message };
  }
  const priorByEdit = new Map<string, number>();
  for (const row of priorRows ?? []) {
    const fid = row.fan_edit_id as string;
    if (!priorByEdit.has(fid)) {
      priorByEdit.set(fid, (row.views_at_calculation as number) ?? 0);
    }
  }

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
  let totalEarningsCents = 0;
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
  if (inserts.length === 0) {
    return { rows_upserted: 0, total_earnings_cents: 0 };
  }

  const { error: upsertErr } = await supabase
    .from("creator_earnings")
    .upsert(inserts, {
      onConflict: "creator_id,fan_edit_id,calculation_date",
    });
  if (upsertErr) {
    return { rows_upserted: 0, total_earnings_cents: 0, error: upsertErr.message };
  }

  return {
    rows_upserted: inserts.length,
    total_earnings_cents: totalEarningsCents,
  };
}
