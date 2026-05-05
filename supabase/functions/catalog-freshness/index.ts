// Block D — catalog freshness Edge Function (v1: changes-feed only).
//
// Reads TMDb /movie/changes and /tv/changes for the prior 24h,
// fetches full details for each id, and upserts into public.titles
// via column allowlist (preserves is_active, is_featured, slug,
// distributor, created_at). Insert vs update is implicit in the
// upsert.
//
// Chunked + checkpointed: each invocation gets one row in
// catalog_sync_runs. If the wall-clock budget is hit before both
// feeds are drained, the row closes with status='partial' and a
// cutoff_token; the NEXT invocation creates a new row, reads the
// previous partial's cutoff_token, and resumes from it before
// pulling fresh changes.
//
// cutoff_token shape:
//   {
//     "current_feed": "movie" | "tv" | "",
//     "current_page": number,
//     "current_page_last_id_processed": number,
//     "feeds_completed": ("movie" | "tv")[]
//   }
//
// When feeds_completed.length === 2 the run finalizes status='success'.
//
// Tripwires (per RUNBOOK_BLOCK_D_CATALOG_FRESHNESS.md). All cause an
// immediate finalize to status='failed' with error_message:
//   - >=1000 changed/new titles in this invocation
//   - unknown media_type encountered
//   - TMDb 401 (auth failure)
// is_active=true row protection is enforced inside upsert.ts and
// reported as `skipped_active` (not a tripwire — log and continue).

import {
  createClient,
  type SupabaseClient,
} from "https://esm.sh/@supabase/supabase-js@2.45.0";
import {
  fetchChangesPage,
  fetchTitleDetails,
  TmdbAuthError,
} from "./tmdb.ts";
import { upsertTitle } from "./upsert.ts";
import {
  finalizeRun,
  loadOrStartRun,
  writeCheckpoint,
  type ResumeState,
  type SyncRunCounters,
} from "./checkpoint.ts";

const FEEDS = ["movie", "tv"] as const;
type Feed = (typeof FEEDS)[number];

// Per-invocation tripwire. The runbook flags >1000 changed titles in
// a single run as suggestive of a TMDb bulk re-tag. We trip per
// invocation rather than across the partial-chain — keeps the logic
// local; if the day's total really is >>1000 we'll still catch it
// because each invocation fills up to 1000 fast and trips. The
// "3 consecutive failed/partial-no-success" tripwire (operational,
// not in code) catches the chain case.
const TRIPWIRE_MAX_CHANGED_TITLES_PER_INVOCATION = 1000;

const DEFAULT_MAX_RUNTIME_SECONDS = 120;
const BUDGET_FRACTION = 0.8;

// CPU is the real constraint, not wall clock. Supabase Edge Functions
// have an undocumented hard CPU-time ceiling (~25-30 s on paid tiers)
// that fires before wall clock for CPU-heavy work like JSON parsing
// of TMDb detail responses + supabase-js record serialization. Caps
// below bound work-per-invocation so we exit cleanly via partial
// before the kill mode trips.
//
// Both env-overridable so we can tune up after observing real
// per-title CPU cost. Starting conservative (50 titles, 3 pages) on
// the principle that under-throttling is cheaper than fighting
// orphan rows.
const DEFAULT_MAX_TITLES_PER_INVOCATION = 50;
const DEFAULT_MAX_PAGES_PER_INVOCATION = 3;

function getEnv(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function budgetMs(): number {
  const raw = Deno.env.get("MAX_RUNTIME_SECONDS");
  const seconds = raw ? Number(raw) : DEFAULT_MAX_RUNTIME_SECONDS;
  if (!Number.isFinite(seconds) || seconds < 30) {
    throw new Error(
      `MAX_RUNTIME_SECONDS must be a finite number >= 30; got ${raw}`,
    );
  }
  return Math.floor(seconds * BUDGET_FRACTION * 1000);
}

function maxTitlesPerInvocation(): number {
  const raw = Deno.env.get("MAX_TITLES_PER_INVOCATION");
  const n = raw ? Number(raw) : DEFAULT_MAX_TITLES_PER_INVOCATION;
  if (!Number.isFinite(n) || n < 1) {
    throw new Error(
      `MAX_TITLES_PER_INVOCATION must be a finite number >= 1; got ${raw}`,
    );
  }
  return Math.floor(n);
}

function maxPagesPerInvocation(): number {
  const raw = Deno.env.get("MAX_PAGES_PER_INVOCATION");
  const n = raw ? Number(raw) : DEFAULT_MAX_PAGES_PER_INVOCATION;
  if (!Number.isFinite(n) || n < 1) {
    throw new Error(
      `MAX_PAGES_PER_INVOCATION must be a finite number >= 1; got ${raw}`,
    );
  }
  return Math.floor(n);
}

// TMDb /changes accepts start_date and end_date (YYYY-MM-DD, UTC).
// We pull the prior 24h: start = today - 1 day, end = today.
function priorDayWindow(): { start: string; end: string } {
  const now = new Date();
  const end = now.toISOString().slice(0, 10);
  const start = new Date(now.getTime() - 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  return { start, end };
}

function jsonResponse(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function totalProcessed(c: SyncRunCounters): number {
  return c.new_titles_count + c.changed_titles_count;
}

Deno.serve(async (_req: Request) => {
  const startTime = Date.now();
  const budget = budgetMs();
  const titlesCap = maxTitlesPerInvocation();
  const pagesCap = maxPagesPerInvocation();

  // Per-invocation work counters — separate from the row counters.
  // Every title processed counts toward titlesThisInvocation
  // regardless of action (inserted, updated, skipped_active,
  // skipped_adult, failed) because each one consumed CPU for the
  // lookup + branch decision. Pages count similarly.
  let titlesThisInvocation = 0;
  let pagesThisInvocation = 0;

  let supabase: SupabaseClient | null = null;
  let runId: string | null = null;
  let state: ResumeState | null = null;
  let counters: SyncRunCounters | null = null;

  try {
    supabase = createClient(
      getEnv("SUPABASE_URL"),
      getEnv("SUPABASE_SERVICE_ROLE_KEY"),
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    const tmdbApiKey = getEnv("TMDB_API_KEY");

    const loaded = await loadOrStartRun(supabase);

    // Short-circuit when today's chain already reached
    // success+feeds_completed=['movie','tv']. No new row inserted in
    // catalog_sync_runs, no TMDb requests, no DB writes. Cron tick
    // after a successful drain is a no-op; saves CPU + bandwidth +
    // avoids re-processing-the-same-pages waste that the prior
    // (status='partial' only) lookup created.
    if (loaded.alreadyCompleted) {
      return jsonResponse({
        status: "success",
        already_completed_today: true,
        most_recent_run_id: loaded.previousRunId,
        counters: loaded.counters,
        elapsed_ms: Date.now() - startTime,
      });
    }

    // Contract: alreadyCompleted=false implies runId is non-null.
    // Defensive narrowing for the type system + a runtime guard if
    // the contract is ever violated by a future change.
    if (!loaded.runId) {
      throw new Error(
        "[catalog-freshness] internal: loadOrStartRun returned null runId without alreadyCompleted",
      );
    }
    runId = loaded.runId;
    state = loaded.state;
    counters = loaded.counters;

    const { start, end } = priorDayWindow();

    for (const feed of FEEDS) {
      if (state.feeds_completed.includes(feed)) continue;

      // If switching to a feed we haven't started yet, reset the page
      // cursor. Resume mid-feed only when state.current_feed already
      // matches.
      if (state.current_feed !== feed) {
        state.current_feed = feed;
        state.current_page = 1;
        state.current_page_last_id_processed = 0;
      }

      let page = state.current_page;

      // while(true) with explicit break on TMDb's authoritative
      // total_pages signal. Earlier shape (`while page <= totalPages`
      // with totalPages=1 sentinel) silently treated any resume with
      // current_page>1 as feed-complete, because the local sentinel
      // didn't carry across invocations and the loop body never ran
      // to fetch the real total_pages. The structural fix here is to
      // never use a sentinel — only break when TMDb tells us the
      // feed is drained, OR when a cap fires.
      while (true) {
        // Page-boundary exit checks. CPU is the binding constraint;
        // we exit BEFORE fetching the next page once we've hit any
        // cap. The wall-clock budget is kept as a defensive secondary.
        if (titlesThisInvocation >= titlesCap) {
          await writeCheckpoint(supabase, runId, state, counters);
          return jsonResponse({
            status: "partial",
            run_id: runId,
            reason: "titles_cap",
            titles_this_invocation: titlesThisInvocation,
            pages_this_invocation: pagesThisInvocation,
            counters,
            state,
            elapsed_ms: Date.now() - startTime,
          });
        }
        if (pagesThisInvocation >= pagesCap) {
          await writeCheckpoint(supabase, runId, state, counters);
          return jsonResponse({
            status: "partial",
            run_id: runId,
            reason: "pages_cap",
            titles_this_invocation: titlesThisInvocation,
            pages_this_invocation: pagesThisInvocation,
            counters,
            state,
            elapsed_ms: Date.now() - startTime,
          });
        }
        if (Date.now() - startTime > budget) {
          await writeCheckpoint(supabase, runId, state, counters);
          return jsonResponse({
            status: "partial",
            run_id: runId,
            reason: "wall_clock_budget",
            titles_this_invocation: titlesThisInvocation,
            pages_this_invocation: pagesThisInvocation,
            counters,
            state,
            elapsed_ms: Date.now() - startTime,
          });
        }

        const pageResult = await fetchChangesPage({
          tmdbApiKey,
          mediaType: feed,
          startDate: start,
          endDate: end,
          page,
        });
        counters.tmdb_changes_pages_fetched += 1;
        pagesThisInvocation += 1;

        for (const idEntry of pageResult.results) {
          const tmdbId = idEntry.id;

          // Re-process the whole page on resume. TMDb /changes ordering
          // is not documented as stable; idempotent upserts make
          // re-processing safe and ~100 wasted calls/resume is negligible.
          // current_page_last_id_processed is still written below for
          // diagnostics/log-grepping but not consulted here.

          // Tripwire: too many touched titles in this invocation.
          // Defensive guard; with titlesCap=50 default this never
          // fires, but if caps are ever dialed up it stays as a stop.
          if (
            totalProcessed(counters) >=
              TRIPWIRE_MAX_CHANGED_TITLES_PER_INVOCATION
          ) {
            const msg =
              `Tripwire: >=${TRIPWIRE_MAX_CHANGED_TITLES_PER_INVOCATION} ` +
              `titles processed in this invocation. Stopping for human review.`;
            await finalizeRun(supabase, runId, "failed", state, counters, msg);
            return jsonResponse({
              status: "failed",
              run_id: runId,
              error: msg,
              counters,
            });
          }

          // No mid-page exit. Page boundary is the only exit gate;
          // we always finish the current page once started so
          // cutoff_token always points at a clean page start on
          // resume.

          try {
            const details = await fetchTitleDetails({
              tmdbApiKey,
              mediaType: feed,
              tmdbId,
            });
            if (details === null) {
              // 404 / unavailable. Common for adult/deleted/private
              // titles in /changes. Count as failed but continue.
              counters.failed_titles_count += 1;
            } else {
              const result = await upsertTitle(supabase, feed, details);
              if (result.action === "inserted") {
                counters.new_titles_count += 1;
              } else if (result.action === "updated") {
                counters.changed_titles_count += 1;
              }
              // skipped_active: logged inside upsert.ts; counters
              // stay flat (not a failure, intentional protection).
            }
          } catch (err) {
            if (err instanceof TmdbAuthError) {
              const msg =
                `TMDb 401 (auth failure). API key may need rotation.`;
              await finalizeRun(
                supabase,
                runId,
                "failed",
                state,
                counters,
                msg,
              );
              return jsonResponse({
                status: "failed",
                run_id: runId,
                error: msg,
                counters,
              });
            }
            counters.failed_titles_count += 1;
            console.error(
              `[catalog-freshness] upsert failed for ${feed}/${tmdbId}:`,
              err instanceof Error ? err.message : err,
            );
          }

          // Per-invocation counter — every title processed counts
          // toward the cap regardless of action, because each one
          // consumed CPU for the lookup + branch decision (inserted,
          // updated, skipped_active, skipped_adult, or failed).
          titlesThisInvocation += 1;

          state.current_page_last_id_processed = tmdbId;
        }

        // Feed-done check using TMDb's authoritative response.
        // total_pages can be 0 (empty feed for the day) or N>=1.
        // A page index >= total_pages with empty results means we
        // just processed the last page (or there were none) — break
        // and let the outer feeds-completed block fire. results
        // length 0 is a defensive secondary in case TMDb returns a
        // valid page index past the end.
        if (
          page >= pageResult.total_pages ||
          pageResult.results.length === 0
        ) {
          break;
        }

        // More pages remain. Advance and loop.
        page += 1;
        state.current_page = page;
        state.current_page_last_id_processed = 0;
      }

      // Feed complete (TMDb confirmed via total_pages).
      state.feeds_completed.push(feed);
      state.current_feed = "";
      state.current_page = 1;
      state.current_page_last_id_processed = 0;
    }

    // Both feeds drained.
    await finalizeRun(supabase, runId, "success", state, counters, null);
    return jsonResponse({
      status: "success",
      run_id: runId,
      counters,
      elapsed_ms: Date.now() - startTime,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[catalog-freshness] fatal:", msg);
    if (supabase && runId) {
      try {
        await finalizeRun(
          supabase,
          runId,
          "failed",
          state ?? {
            current_feed: "",
            current_page: 1,
            current_page_last_id_processed: 0,
            feeds_completed: [],
          },
          counters ?? {
            new_titles_count: 0,
            changed_titles_count: 0,
            failed_titles_count: 0,
            tmdb_changes_pages_fetched: 0,
          },
          msg,
        );
      } catch (finalizeErr) {
        console.error(
          "[catalog-freshness] failed to finalize on fatal:",
          finalizeErr,
        );
      }
    }
    return jsonResponse({ status: "failed", error: msg }, 500);
  }
});

export type { Feed };
