// view_tracking_runs lifecycle helpers.
//
// Catalog-freshness pattern (Block D) with one simplification: there's
// no 'running' status. The view_tracking_runs CHECK constraint allows
// partial/success/failed only. New rows are inserted as 'partial' (the
// safe default if the function dies before writing terminal state)
// and transitioned to success or failed at the end. Naturally self-
// healing: a process death mid-run leaves a partial row with whatever
// counters got written; the next invocation just queries eligibility
// fresh.
//
// Cursor semantics (post-2026-05-07): there is no resume cursor. The
// orchestrator's eligibility query (status='active' AND
// (last_refreshed_at IS NULL OR last_refreshed_at < now() -
// refreshIntervalHours), ORDER BY last_refreshed_at ASC NULLS FIRST)
// already encodes "what's left to do" — successfully refreshed rows
// fall outside the eligibility window and stop appearing; transient/
// parse_error skips leave last_refreshed_at unchanged so the row
// stays at the front of the next invocation's queue and gets
// retried. last_processed_fan_edit_id (UUID) is still written by
// finalizeRun for forensic tracking but is NOT read back as a cursor
// — the previous UUID-cursor design caused real production data
// gaps (rows skipped silently when an EnsembleData transient fired).
//
// Same-UTC-date short-circuit: returns alreadyCompleted=true only
// when BOTH conditions hold:
//   (a) today has at least one successful run with fan_edits_processed
//       > 0 — i.e. the queue has actually drained at some point today;
//   (b) zero fan_edits are currently eligible.
// If (a) is true but (b) finds new eligible rows, we fall through and
// start a fresh run — the post-drain freshness window has reopened
// because new fan_edits were added or existing rows aged past the
// refresh interval.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

export type RunCounters = {
  fan_edits_processed: number;
  fan_edits_succeeded: number;
  fan_edits_failed: number;
  fan_edits_dead_marked: number;
  // Step 1.5 observability: rows that entered/advanced the error backoff this run,
  // and rows marked 'failed' by the parse_error death sweep. Spread into the
  // view_tracking_runs record by updateRunProgress/finalizeRun.
  rows_backed_off: number;
  rows_marked_failed: number;
};

export type LoadResult = {
  alreadyCompleted: boolean;
  runId: string | null;
  counters: RunCounters;
  // The most recent run id that satisfied the short-circuit (drained
  // success), or null. Informational — surfaced in the API response
  // when alreadyCompleted=true.
  previousRunId: string | null;
};

const ZERO_COUNTERS: RunCounters = {
  fan_edits_processed: 0,
  fan_edits_succeeded: 0,
  fan_edits_failed: 0,
  fan_edits_dead_marked: 0,
  rows_backed_off: 0,
  rows_marked_failed: 0,
};

export async function loadOrStartRun(
  supabase: SupabaseClient,
  cpuBudgetMs: number,
  refreshIntervalHours: number,
): Promise<LoadResult> {
  const todayUtcStart = `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;

  // (a) Has today's queue drained at least once — any successful run
  // today with fan_edits_processed > 0? Empty successes don't qualify;
  // they reflect "nothing eligible at run time," not "today is done."
  const { data: drainedRun, error: drainedErr } = await supabase
    .from("view_tracking_runs")
    .select("id")
    .eq("status", "success")
    .gt("fan_edits_processed", 0)
    .gte("started_at", todayUtcStart)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (drainedErr) {
    throw new Error(
      `[view-tracking] failed to query drained runs: ${drainedErr.message}`,
    );
  }

  // (b) If today drained, only short-circuit when nothing is currently
  // eligible. Otherwise the freshness window has reopened post-drain
  // (new fan_edits added today, or existing rows aged past the refresh
  // interval) and we should run again.
  if (drainedRun) {
    const refreshCutoff = new Date(
      Date.now() - refreshIntervalHours * 60 * 60 * 1000,
    ).toISOString();

    // YouTube exclusion removed 2026-05-11 — YT now refreshes via
    // YT Data API v3 in fetchEngagementMetrics. Eligibility count
    // covers all platforms again.
    const { count: eligibleCount, error: eligErr } = await supabase
      .from("fan_edits")
      .select("id", { count: "exact", head: true })
      .eq("view_tracking_status", "active")
      .or(
        `last_refreshed_at.is.null,last_refreshed_at.lt.${refreshCutoff}`,
      );

    if (eligErr) {
      throw new Error(
        `[view-tracking] failed to query eligible fan_edits: ${eligErr.message}`,
      );
    }

    if ((eligibleCount ?? 0) === 0) {
      console.log(
        `[view-tracking] ALREADY_COMPLETED_TODAY drained_run=${drainedRun.id} eligible=0`,
      );
      return {
        alreadyCompleted: true,
        runId: null,
        counters: { ...ZERO_COUNTERS },
        previousRunId: drainedRun.id as string,
      };
    }

    console.log(
      `[view-tracking] DRAINED_BUT_NEW_ELIGIBLE drained_run=${drainedRun.id} eligible=${eligibleCount}`,
    );
    // Fall through — start a fresh run. With timestamp-based ordering
    // there is no cursor to inherit; the orchestrator's eligibility
    // query naturally picks up the oldest-stale rows first.
  }

  const { data: inserted, error: insErr } = await supabase
    .from("view_tracking_runs")
    .insert({
      status: "partial",
      cpu_budget_ms: cpuBudgetMs,
    })
    .select("id")
    .single();

  if (insErr || !inserted) {
    throw new Error(
      `[view-tracking] failed to insert run row: ${
        insErr?.message ?? "no row returned"
      }`,
    );
  }

  return {
    alreadyCompleted: false,
    runId: inserted.id as string,
    counters: { ...ZERO_COUNTERS },
    previousRunId: null,
  };
}

// Lightweight progress update — called after each fan_edit so a
// process death mid-loop loses at most one fan_edit's progress.
// Best-effort: errors are logged and swallowed (the loop continues).
export async function updateRunProgress(
  supabase: SupabaseClient,
  runId: string,
  counters: RunCounters,
  lastProcessedFanEditId: string | null,
): Promise<void> {
  const { error } = await supabase
    .from("view_tracking_runs")
    .update({
      ...counters,
      last_processed_fan_edit_id: lastProcessedFanEditId,
    })
    .eq("id", runId);
  if (error) {
    console.error(
      `[view-tracking] updateRunProgress failed: ${error.message}`,
    );
  }
}

// Terminal transition. Sets status, completed_at, and (for failed
// runs) error_message. Throws on DB error so the orchestrator can
// surface it to the response.
export async function finalizeRun(
  supabase: SupabaseClient,
  runId: string,
  status: "success" | "partial" | "failed",
  counters: RunCounters,
  lastProcessedFanEditId: string | null,
  errorMessage: string | null,
): Promise<void> {
  const { error } = await supabase
    .from("view_tracking_runs")
    .update({
      status,
      ...counters,
      last_processed_fan_edit_id: lastProcessedFanEditId,
      completed_at: new Date().toISOString(),
      error_message: errorMessage,
    })
    .eq("id", runId);
  if (error) {
    throw new Error(
      `[view-tracking] finalizeRun(${status}) failed: ${error.message}`,
    );
  }
}
