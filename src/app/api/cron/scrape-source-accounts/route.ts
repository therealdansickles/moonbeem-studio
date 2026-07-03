// GET /api/cron/scrape-source-accounts — step 3 weekly incremental scrape.
//
// Iterates ACTIVE source accounts and runs one INCREMENTAL scrape each
// (cursor-aware stop + shortcode dedup, so a typical account is ~10 units). The
// ED-unit budget guard is consulted PER ACCOUNT inside scrapeSourceAccount
// (ruling X, 2026-07-03): the meter is re-read before each account, and a budget
// refusal STOPS the run cleanly — remaining accounts are deferred to the next
// weekly run, and because a held cursor never advances past unfetched posts,
// nothing is lost. view-tracking is never blocked by this (wall-clock only).
//
// Schedule: weekly, Monday 08:00 UTC (vercel.json). Auth: the same Bearer
// CRON_SECRET pattern as the other cron routes. Idempotent: incremental scrapes
// are cursor-gated + dedup, so a re-run re-completes without double-work.

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { describeBudgetAbort } from "@/lib/source-accounts/budget";
import {
  scrapeSourceAccount,
  type SourceAccountRow,
} from "@/lib/source-accounts/pipeline";

// Fetch + match per account can run ~1 minute; today's roster is tiny.
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    console.error("[cron/scrape-source-accounts] CRON_SECRET env not set");
    return NextResponse.json(
      { error: "cron_secret_not_configured" },
      { status: 503 },
    );
  }
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${expected}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const supabase = createServiceRoleClient();

  const summary = {
    accounts_seen: 0,
    scraped: 0,
    matches_inserted: 0,
    truncated: 0,
    budget_stopped: false,
    errors: 0,
  };

  // Fairness: never-scraped first, then stalest. Active only.
  const { data: accounts, error: accErr } = await supabase
    .from("source_accounts")
    .select("id, platform, handle, external_user_id, cursor_max_taken_at, active")
    .eq("active", true)
    .order("last_scraped_at", { ascending: true, nullsFirst: true });
  if (accErr) {
    console.error(
      `[cron/scrape-source-accounts] roster query failed: ${accErr.message}`,
    );
    return NextResponse.json(
      { error: "roster_query_failed", message: accErr.message },
      { status: 500 },
    );
  }

  for (const account of accounts ?? []) {
    summary.accounts_seen++;
    let result;
    try {
      result = await scrapeSourceAccount(supabase, account as SourceAccountRow, {
        mode: "incremental",
      });
    } catch (e) {
      summary.errors++;
      console.error(
        `[cron/scrape-source-accounts] threw handle=@${account.handle}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      continue;
    }

    if (!result.ok) {
      if (result.stage === "budget") {
        // Per-account budget refusal: the day's scrape ceiling is reached. Stop the
        // run; remaining accounts wait for next week (cursors held, nothing lost).
        summary.budget_stopped = true;
        console.log(
          `[cron/scrape-source-accounts] BUDGET_STOP handle=@${account.handle} · ${describeBudgetAbort(
            result.decision,
            result.retryAfterUtc,
          )}`,
        );
        break;
      }
      // Park-don't-corrupt: resolve/fetch failure wrote nothing for this account.
      summary.errors++;
      console.warn(
        `[cron/scrape-source-accounts] scrape_${result.stage}_failed handle=@${account.handle} category=${result.error} detail=${result.detail}`,
      );
      continue;
    }

    summary.scraped++;
    summary.matches_inserted += result.matchesInserted;
    if (result.truncated) summary.truncated++;
    console.log(
      `[cron/scrape-source-accounts] scraped handle=@${account.handle} fetched=${result.fetched} new_matches=${result.matchesInserted} truncated=${result.truncated} db_pending=${result.dbPendingMatches}`,
    );
  }

  console.log(
    `[cron/scrape-source-accounts] accounts_seen=${summary.accounts_seen} scraped=${summary.scraped} matches_inserted=${summary.matches_inserted} truncated=${summary.truncated} budget_stopped=${summary.budget_stopped} errors=${summary.errors}`,
  );
  return NextResponse.json(summary);
}
