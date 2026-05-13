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
import { logAdminActionRun } from "@/lib/admin-action-runs";
import { calculateEarningsForRate, type Rate } from "@/lib/earnings-calc";
import { enforce } from "@/lib/ratelimit";

export async function POST() {
  const session = await requireSuperAdmin();
  const rl = await enforce("admin", session.userId, "admin/earnings/calculate");
  if (!rl.ok) return rl.response;
  const startedAt = Date.now();
  const supabase = createServiceRoleClient();
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC

  const { data: rates, error: ratesErr } = await supabase
    .from("partner_title_rates")
    .select("partner_id, title_id, rate_cents_per_thousand")
    .is("deleted_at", null);
  if (ratesErr) {
    await logAdminActionRun({
      action_key: "earnings_calculate",
      triggered_by: session.userId,
      started_at: startedAt,
      ok: false,
      result: null,
      error_message: ratesErr.message,
    });
    return NextResponse.json({ error: ratesErr.message }, { status: 500 });
  }
  const activeRates = (rates ?? []) as Rate[];
  if (activeRates.length === 0) {
    const payload = {
      ok: true,
      titles_processed: 0,
      rows_upserted: 0,
      total_earnings_cents: 0,
      note: "no active partner_title_rates",
    };
    await logAdminActionRun({
      action_key: "earnings_calculate",
      triggered_by: session.userId,
      started_at: startedAt,
      ok: true,
      result: payload,
    });
    return NextResponse.json(payload);
  }

  let titlesProcessed = 0;
  let rowsUpserted = 0;
  let totalEarningsCents = 0;
  const errors: string[] = [];

  for (const rate of activeRates) {
    titlesProcessed += 1;
    const res = await calculateEarningsForRate(supabase, rate, today);
    if (res.error) {
      errors.push(`title ${rate.title_id}: ${res.error}`);
      continue;
    }
    rowsUpserted += res.rows_upserted;
    totalEarningsCents += res.total_earnings_cents;
  }

  const payload = {
    ok: errors.length === 0,
    titles_processed: titlesProcessed,
    rows_upserted: rowsUpserted,
    total_earnings_cents: totalEarningsCents,
    calculation_date: today,
    errors: errors.length > 0 ? errors : undefined,
  };
  await logAdminActionRun({
    action_key: "earnings_calculate",
    triggered_by: session.userId,
    started_at: startedAt,
    ok: payload.ok,
    result: payload,
    error_message: errors.length > 0 ? errors.join("; ") : null,
  });
  return NextResponse.json(payload);
}
