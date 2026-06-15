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
import { PUBLICLY_READABLE_FAN_EDIT_STATUSES } from "@/lib/fan-edits/status";
import { chunkedInOrThrow } from "@/lib/queries/chunked-in";

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
  campaign_id: string | null;
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
    .in("verification_status", PUBLICLY_READABLE_FAN_EDIT_STATUSES)
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
  // Chunked + LOUD-FAIL read of prior-day views. priorRows feeds
  // deltaViews = currentViews − priorViews; a silently-dropped chunk would
  // leave priorViews=0 → deltaViews = the full lifetime view_count → massive
  // over-credit. So a chunk error MUST abort this rate (no upsert), never
  // degrade to empty. chunkedInOrThrow throws on any chunk error; we convert
  // that throw into this function's existing {error} return so the caller's
  // per-rate loop records it and skips the rate — it does NOT fall through to
  // the delta computation or upsert below.
  // Each fan_edit_id falls in exactly one chunk and each chunk is ordered
  // calculation_date DESC, so the first-seen row per edit below is still its
  // most-recent prior calc — identical result to the old single .in().
  let priorRows: Array<{
    fan_edit_id: string;
    calculation_date: string;
    views_at_calculation: number | null;
  }>;
  try {
    priorRows = await chunkedInOrThrow(
      fanEditIds,
      "earnings-calc.priorViews",
      (chunk) =>
        supabase
          .from("creator_earnings")
          .select("fan_edit_id, calculation_date, views_at_calculation")
          .in("fan_edit_id", chunk)
          .lt("calculation_date", today)
          .order("calculation_date", { ascending: false }),
    );
  } catch (e) {
    return {
      rows_upserted: 0,
      total_earnings_cents: 0,
      error: e instanceof Error ? e.message : "prior_views_read_failed",
    };
  }
  const priorByEdit = new Map<string, number>();
  for (const row of priorRows) {
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
    // Chunked + LOUD-FAIL read of is_stub, which drives the `claimed` flag on
    // every earnings row (claimed = !(is_stub ?? true)). The old code
    // destructured only `data` and never checked the error — on a failed or
    // oversized read, stubByCreator stayed empty and EVERY row was silently
    // written claimed=false. Now any chunk error throws and aborts the rate
    // (no upsert); that same throw also supplies the previously-missing error
    // check, so we never proceed with partial creator data.
    let creators: Array<{ id: string; is_stub: boolean | null }>;
    try {
      creators = await chunkedInOrThrow(
        creatorIds,
        "earnings-calc.creatorStub",
        (chunk) =>
          supabase.from("creators").select("id, is_stub").in("id", chunk),
      );
    } catch (e) {
      return {
        rows_upserted: 0,
        total_earnings_cents: 0,
        error: e instanceof Error ? e.message : "creator_stub_read_failed",
      };
    }
    for (const c of creators) {
      stubByCreator.set(c.id, !!c.is_stub);
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
      campaign_id: null,
    });
    totalEarningsCents += earnings;
  }
  if (inserts.length === 0) {
    return { rows_upserted: 0, total_earnings_cents: 0 };
  }

  const { error: upsertErr } = await supabase
    .from("creator_earnings")
    .upsert(inserts, {
      onConflict: "creator_id,fan_edit_id,calculation_date,campaign_id",
    });
  if (upsertErr) {
    return { rows_upserted: 0, total_earnings_cents: 0, error: upsertErr.message };
  }

  return {
    rows_upserted: inserts.length,
    total_earnings_cents: totalEarningsCents,
  };
}
