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
import { getUsedUnits } from "@/lib/source-accounts/ensembledata";
import {
  scrapeSourceAccount,
  BACKFILL_MAX_PAGES,
  INCREMENTAL_MAX_PAGES,
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

  // Budget guard.
  const maxPages = mode === "backfill" ? BACKFILL_MAX_PAGES : INCREMENTAL_MAX_PAGES;
  const projected = maxPages * 10 + 10; // ~1 unit/post * pages*10, + resolve/overhead
  const today = new Date().toISOString().slice(0, 10);
  const units = await getUsedUnits(today);
  const budgetEnv = process.env.ENSEMBLEDATA_DAILY_UNIT_BUDGET;
  const dailyBudget =
    budgetEnv && budgetEnv.trim() !== "" ? Number(budgetEnv) : null;
  if (units.ok && dailyBudget != null && Number.isFinite(dailyBudget)) {
    const remaining = dailyBudget - units.total;
    if (remaining < projected) {
      return NextResponse.json(
        {
          error: "budget_exceeded",
          message: `Projected ~${projected} EnsembleData units, but only ${remaining} of today's ${dailyBudget}-unit budget remain (view-tracking shares this pool). Try later or raise ENSEMBLEDATA_DAILY_UNIT_BUDGET.`,
          today_used: units.total,
          projected,
          budget: dailyBudget,
        },
        { status: 429 },
      );
    }
  }

  const result = await scrapeSourceAccount(
    supabase,
    account as SourceAccountRow,
    { mode },
  );
  if (!result.ok) {
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

  return NextResponse.json({
    ...result,
    budget: units.ok
      ? { today_used: units.total, projected, cap: dailyBudget }
      : { note: "meter_unavailable", projected },
  });
}
