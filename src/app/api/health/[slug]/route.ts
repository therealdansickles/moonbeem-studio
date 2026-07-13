// GET /api/health/[slug] — keyword-monitor pipeline probe (DB-only, v1).
//
// Sibling of GET /api/health (the JSON uptime probe): that one answers "are the
// DB/Redis dependencies up" with a 200/503 split; THIS one answers "are the
// background pipelines actually moving" for a dumb keyword monitor. The slug is
// the whole gate — HEALTH_CHECK_SLUG env, unset-or-mismatch → 404 (fail
// closed). The body carries no secrets, no dollar amounts, no emails: plain
// reason tokens and integer counts only, so obscurity + keyword alerting is the
// accepted v1 posture.
//
// Contract (load-bearing for the UptimeRobot keyword monitor):
//   - ALWAYS HTTP 200 with text/plain, Cache-Control: no-store.
//   - Body is exactly "OK" or "DEGRADED: reason_a; reason_b".
//   - A check that cannot run reports "<name>_check_failed" — still 200, still
//     keyword-alertable. 500 only if the route itself breaks (e.g. the
//     service-role env is missing and createServiceRoleClient throws).
//
// Checks (DB-only; service-role reads, no writes):
//   a. stale_view_tracking — MAX(captured_at) on view_tracking_snapshots older
//      than 36h (or table empty). The tracker stopped producing data.
//   b. empty_tracking_run — zero snapshot rows captured in the last 36h. Kept
//      SEPARATE from (a) per spec (the May silent no-op failure mode: a job
//      that runs but writes nothing must still trip). As implemented on the
//      snapshots table the two predicates co-trip; distinct tokens are kept so
//      monitors and humans see both names, and so (b) can later be re-pointed
//      at view_tracking_runs (runs exist but wrote zero snapshots) without a
//      monitor change.
//   c. failed_payouts:N — campaign_payouts rows with status='failed'.
//   d. stuck_settlements:N — paid entitlements (stripe_payment_intent_id NOT
//      NULL) created > 7 days ago with NO transaction_settlements row.
//      "Settled" is DERIVED (settle cron header: an entitlement with no
//      settlements row), the cron is daily, and Stripe balance transactions
//      settle within ~a week — so a still-rowless week-old paid entitlement
//      means the settle pipeline is silently stuck. No state INSIDE
//      transaction_settlements is time-bound ('held' waits indefinitely for a
//      curator withdrawal; the rest are terminal or externally driven), which
//      is why this check watches the missing-row gap, not a status column.
//   e. EnsembleData daily budget — SKIPPED: no call counter exists in the DB.
//      The budget guard live-reads EnsembleData's own /customer/get-used-units
//      meter (src/lib/source-accounts/budget.ts); discovery_searches only logs
//      per-search unit ESTIMATES for an unrelated admin feature, and
//      view_tracking_runs counts fan_edits processed, not ED calls.

import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { chunkedInOrThrow } from "@/lib/queries/chunked-in";

const TRACKING_STALE_HOURS = 36;
const STUCK_SETTLEMENT_DAYS = 7;
// Bounds the anti-join id set (mirrors the settle cron's CANDIDATE_LIMIT
// posture). If week-old unsettled entitlements ever exceed this, the count
// understates at exactly the moment the alert is already firing — acceptable.
const STUCK_CANDIDATE_LIMIT = 1000;

type Supabase = ReturnType<typeof createServiceRoleClient>;

// (a) stale_view_tracking — newest snapshot older than the threshold.
async function checkStaleViewTracking(
  supabase: Supabase,
  cutoffMs: number,
): Promise<string[]> {
  try {
    const { data, error } = await supabase
      .from("view_tracking_snapshots")
      .select("captured_at")
      .order("captured_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const latestMs = data ? Date.parse(data.captured_at as string) : NaN;
    if (!Number.isFinite(latestMs) || latestMs < cutoffMs) {
      return ["stale_view_tracking"];
    }
    return [];
  } catch (err) {
    console.error(
      `[health/slug] stale_view_tracking check failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return ["stale_view_tracking_check_failed"];
  }
}

// (b) empty_tracking_run — zero snapshots captured inside the window.
async function checkEmptyTrackingRun(
  supabase: Supabase,
  cutoffIso: string,
): Promise<string[]> {
  try {
    const { count, error } = await supabase
      .from("view_tracking_snapshots")
      .select("id", { head: true, count: "exact" })
      .gte("captured_at", cutoffIso);
    if (error) throw new Error(error.message);
    if ((count ?? 0) === 0) return ["empty_tracking_run"];
    return [];
  } catch (err) {
    console.error(
      `[health/slug] empty_tracking_run check failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return ["empty_tracking_run_check_failed"];
  }
}

// (c) failed_payouts:N — any campaign payout in status='failed'.
async function checkFailedPayouts(supabase: Supabase): Promise<string[]> {
  try {
    const { count, error } = await supabase
      .from("campaign_payouts")
      .select("id", { head: true, count: "exact" })
      .eq("status", "failed");
    if (error) throw new Error(error.message);
    const n = count ?? 0;
    if (n > 0) return [`failed_payouts:${n}`];
    return [];
  } catch (err) {
    console.error(
      `[health/slug] failed_payouts check failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return ["failed_payouts_check_failed"];
  }
}

// (d) stuck_settlements:N — paid entitlements past the expected settle window
// with no settlements row (client-side anti-join, same idiom as the settle
// cron). chunkedInOrThrow (the loud-fail variant) on a READ is deliberate: the
// vanilla helper degrades a failed chunk to empty rows, which here would make
// that chunk's entitlements look unsettled and FABRICATE a stuck count. A
// lookup failure must surface as _check_failed, never as an invented positive.
async function checkStuckSettlements(supabase: Supabase): Promise<string[]> {
  try {
    const cutoffIso = new Date(
      Date.now() - STUCK_SETTLEMENT_DAYS * 24 * 3600_000,
    ).toISOString();
    const { data: candidates, error: candErr } = await supabase
      .from("entitlements")
      .select("id")
      .not("stripe_payment_intent_id", "is", null)
      .lt("created_at", cutoffIso)
      .limit(STUCK_CANDIDATE_LIMIT);
    if (candErr) throw new Error(candErr.message);
    const candIds = (candidates ?? []).map((c) => c.id as string);
    if (candIds.length === 0) return [];
    const settledRows = await chunkedInOrThrow<{ entitlement_id: string }>(
      candIds,
      "health stuck_settlements",
      (chunk) =>
        supabase
          .from("transaction_settlements")
          .select("entitlement_id")
          .in("entitlement_id", chunk),
    );
    const settled = new Set(settledRows.map((r) => r.entitlement_id));
    const stuck = candIds.filter((id) => !settled.has(id)).length;
    if (stuck > 0) return [`stuck_settlements:${stuck}`];
    return [];
  } catch (err) {
    console.error(
      `[health/slug] stuck_settlements check failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return ["stuck_settlements_check_failed"];
  }
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const expected = process.env.HEALTH_CHECK_SLUG;
  const { slug } = await params;
  // Fail closed: no env, no endpoint. Mismatch is indistinguishable from a
  // nonexistent route.
  if (!expected || slug !== expected) {
    return new NextResponse(null, { status: 404 });
  }

  const supabase = createServiceRoleClient();
  const cutoffMs = Date.now() - TRACKING_STALE_HOURS * 3600_000;
  const cutoffIso = new Date(cutoffMs).toISOString();

  const reasons = (
    await Promise.all([
      checkStaleViewTracking(supabase, cutoffMs),
      checkEmptyTrackingRun(supabase, cutoffIso),
      checkFailedPayouts(supabase),
      checkStuckSettlements(supabase),
    ])
  ).flat();

  const body =
    reasons.length === 0 ? "OK" : `DEGRADED: ${reasons.join("; ")}`;
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
