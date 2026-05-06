// view_tracking_runs lifecycle helpers.
//
// Mirrors the catalog-freshness checkpoint pattern (Block D) with two
// simplifications:
//   1. The resume cursor is a typed UUID FK (last_processed_fan_edit_id)
//      rather than the open jsonb cutoff_token from Block D — we always
//      know the cursor shape for this pipeline.
//   2. There's no 'running' status. The view_tracking_runs CHECK
//      constraint allows partial/success/failed only. New rows are
//      inserted as 'partial' (the safe default if the function dies
//      before writing terminal state) and transitioned to success or
//      failed at the end. Naturally self-healing: a process death mid-
//      run leaves a partial row with whatever counters got written;
//      the next invocation finds it (same UTC day) and resumes from
//      its last_processed_fan_edit_id.
//
// Same-UTC-date short-circuit: if today has ANY successful run that
// processed > 0 fan_edits, return alreadyCompleted=true. An empty
// success (processed=0) does NOT short-circuit — it just means
// nothing was eligible at the moment that run fired; more fan_edits
// may be eligible later in the day.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

export type RunCounters = {
  fan_edits_processed: number;
  fan_edits_succeeded: number;
  fan_edits_failed: number;
  fan_edits_dead_marked: number;
};

export type LoadResult = {
  alreadyCompleted: boolean;
  runId: string | null;
  // Resume cursor: last fan_edit id processed by the most recent
  // partial run from today's UTC day. New invocations filter
  // fan_edits.id > this value.
  lastProcessedFanEditId: string | null;
  counters: RunCounters;
  previousRunId: string | null;
};

const ZERO_COUNTERS: RunCounters = {
  fan_edits_processed: 0,
  fan_edits_succeeded: 0,
  fan_edits_failed: 0,
  fan_edits_dead_marked: 0,
};

export async function loadOrStartRun(
  supabase: SupabaseClient,
  cpuBudgetMs: number,
): Promise<LoadResult> {
  const todayUtcStart = `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;

  // Short-circuit only if today's queue has actually drained at some
  // point — i.e. any successful run today processed > 0 fan_edits.
  // Empty successes don't qualify: they reflect "nothing eligible at
  // run time," not "today is done."
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

  if (drainedRun) {
    console.log(
      `[view-tracking] ALREADY_COMPLETED_TODAY drained_run=${drainedRun.id}`,
    );
    return {
      alreadyCompleted: true,
      runId: null,
      lastProcessedFanEditId: null,
      counters: { ...ZERO_COUNTERS },
      previousRunId: drainedRun.id as string,
    };
  }

  // No drained success today. Look for a partial run to recover
  // the resume cursor from. Empty successes are skipped — they
  // hold no meaningful cursor to resume from.
  const { data: candidate, error: qErr } = await supabase
    .from("view_tracking_runs")
    .select("id, last_processed_fan_edit_id")
    .eq("status", "partial")
    .gte("started_at", todayUtcStart)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (qErr) {
    throw new Error(
      `[view-tracking] failed to query candidate runs: ${qErr.message}`,
    );
  }

  // Resume from prior partial's cursor, OR fresh chain (null cursor).
  // Note we DON'T carry counters forward — each invocation gets its
  // own row with its own counters (per-row, not chain-cumulative),
  // matching Block D's catalog-freshness pattern.
  const lastProcessedFanEditId =
    (candidate?.last_processed_fan_edit_id as string | null) ?? null;

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
    lastProcessedFanEditId,
    counters: { ...ZERO_COUNTERS },
    previousRunId: (candidate?.id as string) ?? null,
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
