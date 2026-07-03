// POST /api/admin/source-accounts/[id]/scrape
//
// Runs one scrape for a source account: fetch posts -> upsert queue rows -> match
// unmatched posts -> queue per-title matches. Body: { mode?: 'backfill' |
// 'incremental' } (default 'backfill'). Super-admin only.
//
// Budget guard (recon flag 1): the EnsembleData token is SHARED with the live
// view-tracking cron, so before spending we read the daily meter and, IF a cap is
// configured (ENSEMBLEDATA_DAILY_UNIT_BUDGET), abort when the projected cost would
// eat into the day's remaining pool. The cap is env-driven and OFF by default: the
// documented "Wood plan = 1500/day" is contradicted by live usage, so hard-coding
// it would spuriously block. Set the env to the real cap to enforce.

import { NextResponse, type NextRequest } from "next/server";
import { requireSuperAdmin } from "@/lib/dal";
import { enforce } from "@/lib/ratelimit";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { describeBudgetAbort } from "@/lib/source-accounts/budget";
import {
  scrapeSourceAccount,
  type ScrapeMode,
  type SourceAccountRow,
} from "@/lib/source-accounts/pipeline";

// Fetch + match of a full backfill can run ~1 minute; give it headroom.
export const maxDuration = 300;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireSuperAdmin();
  const rl = await enforce("admin", session.userId, "admin/source-accounts/scrape");
  if (!rl.ok) return rl.response;
  const { id } = await params;

  let body: { mode?: unknown } = {};
  try {
    body = (await request.json()) as { mode?: unknown };
  } catch {
    // empty body is fine — defaults to backfill
  }
  const mode: ScrapeMode = body.mode === "incremental" ? "incremental" : "backfill";

  const supabase = createServiceRoleClient();
  const { data: account, error: accErr } = await supabase
    .from("source_accounts")
    .select("id, platform, handle, external_user_id, cursor_max_taken_at, active")
    .eq("id", id)
    .maybeSingle();
  if (accErr) return NextResponse.json({ error: accErr.message }, { status: 500 });
  if (!account) return NextResponse.json({ error: "account_not_found" }, { status: 404 });
  if (account.active === false) {
    return NextResponse.json({ error: "account_inactive" }, { status: 400 });
  }

  // The ED-unit budget guard lives INSIDE scrapeSourceAccount (the single
  // chokepoint the cron shares), so it runs per account before any spend. Here we
  // only map its outcome: a budget refusal is a clean, labeled 429 (never-silent),
  // NOT a failure.
  let result;
  try {
    result = await scrapeSourceAccount(supabase, account as SourceAccountRow, {
      mode,
    });
  } catch (e) {
    // A DB write inside the pipeline threw (checked + surfaced, never silent).
    return NextResponse.json(
      {
        error: "scrape_write_failed",
        detail: e instanceof Error ? e.message : String(e),
      },
      { status: 500 },
    );
  }
  if (!result.ok) {
    if (result.stage === "budget") {
      const d = result.decision;
      return NextResponse.json(
        {
          error: "budget_exceeded",
          reason: d.reason,
          message: describeBudgetAbort(d, result.retryAfterUtc),
          today_used: d.unitsToday,
          projected: d.projected,
          ceiling: d.scrapeCeiling,
          budget: d.budget,
          reserved_view_tracking: d.reservedVt,
          retry_after_utc: result.retryAfterUtc,
        },
        { status: 429 },
      );
    }
    // Park-don't-corrupt: resolve/fetch failures wrote nothing.
    return NextResponse.json(
      {
        error: `scrape_${result.stage}_failed`,
        category: result.error,
        detail: result.detail,
      },
      { status: 502 },
    );
  }

  return NextResponse.json(result);
}
