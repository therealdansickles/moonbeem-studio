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
import { fetchInstagramPosts, resolveInstagramUserId } from "./ensembledata";
import {
  computeIncrementalCursor,
  extractTitleCandidates,
  type NormalizedPost,
} from "./normalize";
import { topMatchesPerGroup } from "./matcher";

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
};

export type ScrapeError = {
  ok: false;
  stage: "resolve" | "fetch";
  error: string;
  detail: string;
};

export const BACKFILL_MAX_PAGES = 20; // ~200 posts capacity (docstowatch = 153)
export const INCREMENTAL_MAX_PAGES = 8; // oldest_timestamp stops pagination early
export const MATCH_THRESHOLD = 0.6;

export async function scrapeSourceAccount(
  supabase: SupabaseClient,
  account: SourceAccountRow,
  opts: { mode: ScrapeMode },
): Promise<ScrapeSummary | ScrapeError> {
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
  const maxPages =
    opts.mode === "backfill" ? BACKFILL_MAX_PAGES : INCREMENTAL_MAX_PAGES;
  const oldestTimestamp =
    opts.mode === "incremental" ? account.cursor_max_taken_at : null;
  const fetched = await fetchInstagramPosts(userId, { maxPages, oldestTimestamp });
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

  // 6. Advance the cursor forward-only, over NON-pinned posts only.
  const runCursor = computeIncrementalCursor(posts);
  const advanced =
    Math.max(account.cursor_max_taken_at ?? 0, runCursor ?? 0) || null;
  await supabase
    .from("source_accounts")
    .update({
      last_scraped_at: new Date().toISOString(),
      cursor_max_taken_at: advanced,
    })
    .eq("id", account.id);

  return {
    ok: true,
    mode: opts.mode,
    userId,
    fetched: posts.length,
    rawCount: fetched.rawCount,
    truncated: fetched.truncated,
    processedPosts,
    matchesInserted,
    noMatchPosts,
    cursorMaxTakenAt: advanced,
  };
}
