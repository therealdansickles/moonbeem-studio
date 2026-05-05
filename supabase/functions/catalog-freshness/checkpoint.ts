// Resume / checkpoint logic for the catalog-freshness Edge Function.
//
// Each invocation creates ONE row in catalog_sync_runs. State carries
// across the partial-chain via cutoff_token (jsonb) — never via
// row updates. So a chain looks like:
//
//   row_1: status='partial', cutoff_token={current_feed:"movie", current_page:7, ...}
//   row_2: status='partial', cutoff_token={current_feed:"tv",    current_page:2, ...}
//   row_3: status='success', cutoff_token={feeds_completed:["movie","tv"]}
//
// loadOrStartRun:
//   1. Look back PARTIAL_LOOKBACK_HOURS (36h) for the most recent
//      row with status='partial'. 36h gives chain continuity slack
//      across the 24h cron boundary so a chain spanning the daily
//      tick doesn't accidentally start a fresh one.
//   2. If found: parse its cutoff_token into ResumeState. Insert a
//      NEW row with status='running' and cutoff_token initialized
//      from that state. Counters start at zero (per-row, not chain-
//      cumulative).
//   3. If not found: insert a NEW row with status='running' and a
//      fresh ResumeState (no feeds completed, no current feed yet).
//
// writeCheckpoint:
//   Updates THIS run's row with status='partial' and the current
//   cutoff_token + counters + completed_at.
//
// finalizeRun:
//   Updates THIS run's row with status='success' or 'failed' and
//   the final cutoff_token + counters + completed_at + (optional)
//   error_message.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

// Any 'running' row older than this is treated as orphaned. The Edge
// Function was killed (CPU/wall-clock limit) before reaching
// writeCheckpoint or finalizeRun. Orphan rows have no useful
// cutoff_token (still at insert-time fresh state) so we mark them
// failed and don't attempt to resume from them.
const ORPHAN_AGE_MINUTES = 5;

export type ResumeState = {
  current_feed: "movie" | "tv" | "";
  current_page: number;
  current_page_last_id_processed: number;
  feeds_completed: ("movie" | "tv")[];
};

export type SyncRunCounters = {
  new_titles_count: number;
  changed_titles_count: number;
  failed_titles_count: number;
  tmdb_changes_pages_fetched: number;
};

export type SyncRunStatus = "running" | "partial" | "success" | "failed";

// LoadResult represents either:
//   (a) a normal "do work" path — alreadyCompleted=false, runId
//       points at the freshly-inserted running row, state and
//       counters are initialized; OR
//   (b) a no-op short-circuit — alreadyCompleted=true, runId=null
//       (no new row inserted), previousRunId points at today's
//       completed chain. index.ts returns early without entering
//       the feed loop.
type LoadResult = {
  alreadyCompleted: boolean;
  runId: string | null;
  state: ResumeState;
  counters: SyncRunCounters;
  previousRunId: string | null;
};

function freshState(): ResumeState {
  return {
    current_feed: "",
    current_page: 1,
    current_page_last_id_processed: 0,
    feeds_completed: [],
  };
}

function freshCounters(): SyncRunCounters {
  return {
    new_titles_count: 0,
    changed_titles_count: 0,
    failed_titles_count: 0,
    tmdb_changes_pages_fetched: 0,
  };
}

// Parse a cutoff_token jsonb blob defensively. Anything missing or
// shape-drifted falls back to fresh state — we'd rather restart a
// feed cleanly than crash on a bad token.
function parseCutoff(raw: unknown): ResumeState {
  if (!raw || typeof raw !== "object") return freshState();
  const obj = raw as Record<string, unknown>;
  const cf = obj.current_feed;
  const current_feed: ResumeState["current_feed"] =
    cf === "movie" || cf === "tv" || cf === "" ? cf : "";
  const current_page = typeof obj.current_page === "number" &&
      Number.isFinite(obj.current_page) && obj.current_page >= 1
    ? Math.floor(obj.current_page)
    : 1;
  const current_page_last_id_processed =
    typeof obj.current_page_last_id_processed === "number" &&
      Number.isFinite(obj.current_page_last_id_processed)
      ? Math.floor(obj.current_page_last_id_processed)
      : 0;
  const feedsRaw = Array.isArray(obj.feeds_completed)
    ? obj.feeds_completed
    : [];
  const feeds_completed = feedsRaw.filter(
    (v): v is "movie" | "tv" => v === "movie" || v === "tv",
  );
  return {
    current_feed,
    current_page,
    current_page_last_id_processed,
    feeds_completed,
  };
}

export async function loadOrStartRun(
  supabase: SupabaseClient,
): Promise<LoadResult> {
  await recoverOrphanedRunningRows(supabase);

  // Same-UTC-date heuristic. /movie/changes and /tv/changes accept
  // start_date / end_date as YYYY-MM-DD (UTC), and our priorDayWindow
  // helper buckets on the same calendar boundary. So our resume
  // semantics align with our data semantics: today's chain == rows
  // started on today's UTC date. A success at 06:00 UTC bars more
  // work until 00:00 UTC tomorrow; a partial from yesterday's chain
  // is ignored (we won't resume into a stale data window).
  const todayUtcStart = `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;

  // Single query: most recent terminal-or-partial row from today.
  // status='success' wins us a short-circuit; status='partial' wins
  // us a resume; nothing returned means fresh chain.
  const candidate = await supabase
    .from("catalog_sync_runs")
    .select("id, status, cutoff_token, started_at")
    .in("status", ["partial", "success"])
    .gte("started_at", todayUtcStart)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (candidate.error) {
    throw new Error(
      `[catalog-freshness] failed to query candidate runs: ${candidate.error.message}`,
    );
  }

  if (candidate.data) {
    const cState = parseCutoff(candidate.data.cutoff_token);
    if (
      candidate.data.status === "success" &&
      cState.feeds_completed.length === 2
    ) {
      // Today's chain is already complete. Short-circuit: no new
      // row, no work, return immediately. index.ts checks
      // alreadyCompleted and emits the no-op success response.
      console.log(
        `[catalog-freshness] ALREADY_COMPLETED_TODAY most_recent_run=${candidate.data.id}`,
      );
      return {
        alreadyCompleted: true,
        runId: null,
        state: cState,
        counters: freshCounters(),
        previousRunId: candidate.data.id as string,
      };
    }
    // Otherwise it's a partial from today; fall through to the
    // resume path with this state.
  }

  const state = candidate.data
    ? parseCutoff(candidate.data.cutoff_token)
    : freshState();

  // Insert a new running row for this invocation. Status starts as
  // 'running'; will transition to partial/success/failed before exit.
  const inserted = await supabase
    .from("catalog_sync_runs")
    .insert({
      status: "running",
      cutoff_token: state,
      new_titles_count: 0,
      changed_titles_count: 0,
      failed_titles_count: 0,
      tmdb_changes_pages_fetched: 0,
    })
    .select("id")
    .single();

  if (inserted.error || !inserted.data) {
    throw new Error(
      `[catalog-freshness] failed to insert running row: ${
        inserted.error?.message ?? "no row returned"
      }`,
    );
  }

  return {
    alreadyCompleted: false,
    runId: inserted.data.id as string,
    state,
    counters: freshCounters(),
    previousRunId: null,
  };
}

async function recoverOrphanedRunningRows(
  supabase: SupabaseClient,
): Promise<void> {
  const cutoffIso = new Date(
    Date.now() - ORPHAN_AGE_MINUTES * 60 * 1000,
  ).toISOString();

  const orphans = await supabase
    .from("catalog_sync_runs")
    .select("id, started_at")
    .eq("status", "running")
    .lt("started_at", cutoffIso);

  if (orphans.error) {
    throw new Error(
      `[catalog-freshness] failed to query orphaned runs: ${orphans.error.message}`,
    );
  }

  for (const orphan of orphans.data ?? []) {
    const ageMinutes = Math.floor(
      (Date.now() - new Date(orphan.started_at as string).getTime()) /
        60_000,
    );
    const update = await supabase
      .from("catalog_sync_runs")
      .update({
        status: "failed",
        error_message:
          "orphaned (likely CPU/wall-clock kill); auto-recovered",
        completed_at: new Date().toISOString(),
      })
      .eq("id", orphan.id)
      // Race-safety: only flip if still 'running'. If another
      // concurrent invocation got there first, leave it alone.
      .eq("status", "running");

    if (update.error) {
      console.error(
        `[catalog-freshness] failed to recover orphan ${orphan.id}: ${update.error.message}`,
      );
      continue;
    }
    console.log(
      `[catalog-freshness] ORPHAN_RECOVERED run_id=${orphan.id} age_minutes=${ageMinutes}`,
    );
  }
}

export async function writeCheckpoint(
  supabase: SupabaseClient,
  runId: string,
  state: ResumeState,
  counters: SyncRunCounters,
): Promise<void> {
  const { error } = await supabase
    .from("catalog_sync_runs")
    .update({
      status: "partial",
      cutoff_token: state,
      new_titles_count: counters.new_titles_count,
      changed_titles_count: counters.changed_titles_count,
      failed_titles_count: counters.failed_titles_count,
      tmdb_changes_pages_fetched: counters.tmdb_changes_pages_fetched,
      completed_at: new Date().toISOString(),
    })
    .eq("id", runId);
  if (error) {
    throw new Error(
      `[catalog-freshness] writeCheckpoint failed for run ${runId}: ${error.message}`,
    );
  }
}

export async function finalizeRun(
  supabase: SupabaseClient,
  runId: string,
  status: "success" | "failed",
  state: ResumeState,
  counters: SyncRunCounters,
  errorMessage: string | null,
): Promise<void> {
  const { error } = await supabase
    .from("catalog_sync_runs")
    .update({
      status,
      cutoff_token: state,
      new_titles_count: counters.new_titles_count,
      changed_titles_count: counters.changed_titles_count,
      failed_titles_count: counters.failed_titles_count,
      tmdb_changes_pages_fetched: counters.tmdb_changes_pages_fetched,
      error_message: errorMessage,
      completed_at: new Date().toISOString(),
    })
    .eq("id", runId);
  if (error) {
    throw new Error(
      `[catalog-freshness] finalizeRun(${status}) failed for run ${runId}: ${error.message}`,
    );
  }
}
