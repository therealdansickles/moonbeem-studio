// Source Accounts — scrape pipeline (server-only).
//
// One entry point, scrapeSourceAccount(), runs the whole flow for one account:
//   resolve handle -> user_id (cached on the row)
//   fetch posts (backfill: depth pages; incremental: oldest_timestamp = cursor)
//   dedup by shortcode (pinned posts can appear twice in one response)
//   upsert post rows (mutable display fields refreshed; matched_at preserved)
//   match ONLY posts not yet matched (matched_at IS NULL) -> top-N per-title rows
//   stamp matched_at on every processed post (incl. zero-match, so re-scrape skips)
//   advance the account cursor forward-only over NON-pinned posts
//
// PARK-DON'T-CORRUPT: resolve/fetch failures return an error BEFORE any write, so
// a bad ED response never lands partial rows. Post-fetch DB steps are idempotent
// (upserts + a gated matched_at), so a mid-run failure re-completes on the next run.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  fetchInstagramPosts,
  resolveInstagramUserId,
  getUsedUnits,
} from "./ensembledata";
import {
  computeIncrementalCursor,
  extractTitleCandidates,
  type NormalizedPost,
} from "./normalize";
import { topMatchesPerGroup } from "./matcher";
import {
  resolveBudgetConfig,
  scrapeBudgetDecision,
  hoursRemainingInUtcDay,
  nextUtcMidnight,
  projectedUnits,
  type BudgetDecision,
} from "./budget";

export type SourceAccountRow = {
  id: string;
  platform: string;
  handle: string;
  external_user_id: string | null;
  cursor_max_taken_at: number | null;
};

export type ScrapeMode = "backfill" | "incremental";

export type ScrapeSummary = {
  ok: true;
  mode: ScrapeMode;
  userId: string;
  fetched: number; // normalized, deduped posts this run
  rawCount: number | null; // account's total post count per ED
  truncated: boolean; // backfill hit the depth cap; a tail remains
  processedPosts: number; // posts the matcher ran on this run
  matchesInserted: number; // pending match rows actually inserted
  noMatchPosts: number; // processed posts that yielded zero catalog matches
  cursorMaxTakenAt: number | null;
  // Never-silent persistence: DB-CONFIRMED counts (post-write SELECT), so the
  // panel reports what actually landed, not in-memory tallies.
  dbPostsTotal: number;
  dbPendingMatches: number;
};

export type ScrapeError = {
  ok: false;
  stage: "resolve" | "fetch";
  error: string;
  detail: string;
};

// A clean, labeled refusal — NOT a failure. Only scrapes can hit this; the guard
// runs per account before any spend. Callers render it as a normal held state
// (never-silent) and, for the cron, stop the run (budget reached, rest deferred).
export type ScrapeBudgetAbort = {
  ok: false;
  stage: "budget";
  decision: BudgetDecision;
  retryAfterUtc: string;
};

// EnsembleData's `depth` caps at ~8 pages (~80 posts) per call; backfill drains the
// rest via start_cursor across up to MAX_CALLS calls (docstowatch = 153 -> 2 calls).
// Incremental relies on oldest_timestamp to stop server-side, so it needs few calls.
export const BACKFILL_PAGE_DEPTH = 8;
export const BACKFILL_MAX_CALLS = 6; // up to ~480 posts before truncating
export const INCREMENTAL_PAGE_DEPTH = 8;
// Incremental is bounded by a CURSOR-AWARE stop, not the call budget: it follows
// start_cursor only while still ABOVE the cursor (catching up), and stops the moment
// a fetched non-pinned post reaches back to (<=) the cursor — so a typical week is
// ONE ~10-unit call. The cap (3) is just a burst backstop: if a burst exceeds it,
// the run is flagged truncated and the cursor is HELD (not advanced) so a re-run
// closes the gap. An oldest_timestamp response still carries a last_cursor, which is
// why "one call" alone isn't enough — the stop must be cursor-aware, not budget-only.
export const INCREMENTAL_MAX_CALLS = 3;
export const MATCH_THRESHOLD = 0.6;

export async function scrapeSourceAccount(
  supabase: SupabaseClient,
  account: SourceAccountRow,
  opts: { mode: ScrapeMode },
): Promise<ScrapeSummary | ScrapeError | ScrapeBudgetAbort> {
  // 0. Budget guard (ruling X, 2026-07-03). ONLY scrapes abort on units;
  //    view-tracking never consults this (it is wall-clock bounded). The guard
  //    lives HERE, at the single chokepoint, so the admin route AND the step-3
  //    cron both inherit it — and the meter is re-read on every call, so the cron
  //    re-checks before EACH account (no burst-lag window). The meter is
  //    EnsembleData's own get-used-units — the billing truth for the shared token,
  //    already counting view-tracking + scrapes incl. failed-but-charged calls.
  //    FAIL-CLOSED: an unreadable meter refuses the scrape (see budget.ts).
  const now = new Date();
  const projected = projectedUnits(
    opts.mode === "backfill" ? BACKFILL_PAGE_DEPTH : INCREMENTAL_PAGE_DEPTH,
    opts.mode === "backfill" ? BACKFILL_MAX_CALLS : INCREMENTAL_MAX_CALLS,
  );
  const meter = await getUsedUnits(now.toISOString().slice(0, 10));
  const decision = scrapeBudgetDecision({
    config: resolveBudgetConfig(),
    hoursRemaining: hoursRemainingInUtcDay(now),
    unitsToday: meter.ok ? meter.total : null,
    projected,
  });
  if (!decision.allow) {
    return {
      ok: false,
      stage: "budget",
      decision,
      retryAfterUtc: nextUtcMidnight(now).toISOString(),
    };
  }

  // 1. Resolve user id if we don't have it yet; cache it on the account row.
  let userId = account.external_user_id;
  if (!userId) {
    const r = await resolveInstagramUserId(account.handle);
    if (!r.ok) return { ok: false, stage: "resolve", error: r.error, detail: r.detail };
    userId = r.userId;
    await supabase
      .from("source_accounts")
      .update({ external_user_id: userId })
      .eq("id", account.id);
  }

  // 2. Fetch (park on any bad response — nothing is written yet).
  const isBackfill = opts.mode === "backfill";
  const cursor = account.cursor_max_taken_at;
  const fetched = await fetchInstagramPosts(userId, {
    pageDepth: isBackfill ? BACKFILL_PAGE_DEPTH : INCREMENTAL_PAGE_DEPTH,
    maxCalls: isBackfill ? BACKFILL_MAX_CALLS : INCREMENTAL_MAX_CALLS,
    oldestTimestamp: isBackfill ? null : cursor,
    // Incremental stop discriminator: a fetched NON-PINNED post has reached back to
    // (<=) the cursor, so every newer post is already captured. Pins are excluded —
    // they are always old and would false-trigger on page 1 during a burst.
    reachedCursor:
      !isBackfill && cursor != null
        ? (posts) =>
            posts.some(
              (p) => !p.is_pinned && p.taken_at != null && p.taken_at <= cursor,
            )
        : undefined,
  });
  if (!fetched.ok) {
    return { ok: false, stage: "fetch", error: fetched.error, detail: fetched.detail };
  }

  // Dedup by shortcode (a pinned post can appear both hoisted and in-chrono).
  const byCode = new Map<string, NormalizedPost>();
  for (const p of fetched.posts) if (!byCode.has(p.shortcode)) byCode.set(p.shortcode, p);
  const posts = Array.from(byCode.values());

  let processedPosts = 0;
  let matchesInserted = 0;
  let noMatchPosts = 0;

  if (posts.length > 0) {
    // 3. Upsert post rows. Columns omitted from the payload (matched_at, created_at)
    //    are preserved on conflict, so an already-matched post stays matched.
    const rows = posts.map((p) => ({
      source_account_id: account.id,
      shortcode: p.shortcode,
      post_url: p.post_url,
      caption: p.caption,
      taken_at: p.taken_at,
      is_pinned: p.is_pinned,
      media_type: p.media_type,
      video_view_count: p.video_view_count,
      like_count: p.like_count,
    }));
    const { data: upserted, error: upErr } = await supabase
      .from("source_account_posts")
      .upsert(rows, { onConflict: "source_account_id,shortcode" })
      .select("id, caption, matched_at");
    if (upErr) throw new Error(`source_account_posts upsert failed: ${upErr.message}`);

    const unmatched = ((upserted ?? []) as {
      id: string;
      caption: string | null;
      matched_at: string | null;
    }[]).filter((r) => r.matched_at == null);
    processedPosts = unmatched.length;

    if (unmatched.length > 0) {
      // 4. Match: top-N distinct-title matches per post (one flattened chunked pass).
      const groups = unmatched.map((r) => extractTitleCandidates(r.caption));
      const top = await topMatchesPerGroup(supabase, groups, {
        threshold: MATCH_THRESHOLD,
      });

      const matchRows: {
        source_account_post_id: string;
        matched_title_id: string;
        match_confidence: number;
        status: string;
      }[] = [];
      top.forEach((matches, i) => {
        if (matches.length === 0) noMatchPosts += 1;
        for (const m of matches) {
          matchRows.push({
            source_account_post_id: unmatched[i].id,
            matched_title_id: m.title_id,
            match_confidence: m.confidence,
            status: "pending",
          });
        }
      });

      if (matchRows.length > 0) {
        const { data: inserted, error: mErr } = await supabase
          .from("source_account_post_matches")
          .upsert(matchRows, {
            onConflict: "source_account_post_id,matched_title_id",
            ignoreDuplicates: true,
          })
          .select("id");
        if (mErr) throw new Error(`matches upsert failed: ${mErr.message}`);
        matchesInserted = inserted?.length ?? 0;
      }

      // 5. Stamp matched_at on EVERY processed post (incl. zero-match) so a
      //    re-scrape skips them.
      const { error: markErr } = await supabase
        .from("source_account_posts")
        .update({ matched_at: new Date().toISOString() })
        .in(
          "id",
          unmatched.map((r) => r.id),
        );
      if (markErr) throw new Error(`matched_at update failed: ${markErr.message}`);
    }
  }

  // 6. Advance the cursor forward-only, over NON-pinned posts only — UNLESS this was
  //    a truncated incremental (a burst exceeded the call cap). Then HOLD the cursor:
  //    advancing past the unfetched newer posts would seal them permanently; holding
  //    it lets the next run (or a backfill) close the gap, and dedup makes the
  //    re-seen posts free. last_scraped_at still updates (a scrape did happen).
  const runCursor = computeIncrementalCursor(posts);
  const holdCursor = !isBackfill && fetched.truncated;
  const advanced = holdCursor
    ? (account.cursor_max_taken_at ?? null)
    : Math.max(account.cursor_max_taken_at ?? 0, runCursor ?? 0) || null;
  await supabase
    .from("source_accounts")
    .update({
      last_scraped_at: new Date().toISOString(),
      cursor_max_taken_at: advanced,
    })
    .eq("id", account.id);

  // 7. Never-silent persistence: read back the DB-CONFIRMED counts for this account
  //    so the panel reports what actually landed, not the in-memory tallies above.
  const { count: dbPostsTotal } = await supabase
    .from("source_account_posts")
    .select("id", { count: "exact", head: true })
    .eq("source_account_id", account.id);
  const { count: dbPendingMatches } = await supabase
    .from("source_account_post_matches")
    .select("id, source_account_posts!inner(source_account_id)", {
      count: "exact",
      head: true,
    })
    .eq("status", "pending")
    .eq("source_account_posts.source_account_id", account.id);

  return {
    ok: true,
    mode: opts.mode,
    userId,
    fetched: posts.length,
    rawCount: fetched.rawCount,
    // Evidence-based per mode (computed in drainPages): backfill = cap hit with a
    // cursor open; incremental = cap hit before reachedCursor fired (new posts may
    // remain). A normal incremental that catches up to the cursor is truncated=false.
    truncated: fetched.truncated,
    processedPosts,
    matchesInserted,
    noMatchPosts,
    cursorMaxTakenAt: advanced,
    dbPostsTotal: dbPostsTotal ?? 0,
    dbPendingMatches: dbPendingMatches ?? 0,
  };
}
