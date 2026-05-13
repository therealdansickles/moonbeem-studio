// GET /api/cron/drain-email-queue — Vercel cron entrypoint.
//
// Schedule: every 5 minutes (configured in vercel.json). Drains any
// queue rows that the hot-path after() handler didn't reach (cold
// starts, transient Resend failures, function timeouts mid-flight).
// Hot path is the happy case; this is the safety net.
//
// Auth: Bearer CRON_SECRET. Vercel cron automatically attaches the
// CRON_SECRET env value to the Authorization header on scheduled
// invocations. Same secret + header check works for manual curl
// invocations during testing.
//
// Failure modes:
//   - CRON_SECRET env missing → 503 (misconfiguration; not the
//     caller's fault)
//   - Wrong/missing Authorization header → 401
//   - drainQueue throws → 500 + log; cron will retry on next schedule
//   - Empty queue → 200 with { drained: 0, ... }

import { NextResponse, type NextRequest } from "next/server";
import { drainQueue } from "@/lib/email-queue";

const MAX_ROWS_PER_RUN = 100;
const BUDGET_MS = 25_000;

export async function GET(request: NextRequest) {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    console.error("[cron/drain-email-queue] CRON_SECRET env not set");
    return NextResponse.json(
      { error: "cron_secret_not_configured" },
      { status: 503 },
    );
  }

  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${expected}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const result = await drainQueue({
      maxRows: MAX_ROWS_PER_RUN,
      budgetMs: BUDGET_MS,
    });
    console.log(
      `[cron/drain-email-queue] drained=${result.drained} failed=${result.failed} failed_permanent=${result.failed_permanent} skipped_budget=${result.skipped_budget} elapsed_ms=${result.elapsed_ms}`,
    );
    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[cron/drain-email-queue] drain threw: ${msg}`);
    return NextResponse.json(
      { error: "drain_failed", message: msg },
      { status: 500 },
    );
  }
}
