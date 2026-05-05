// view-tracking Edge Function — daily refresh of fan_edit engagement
// metrics via EnsembleData.
//
// Orchestration (mirrors the Block D catalog-freshness pattern):
//   1. loadOrStartRun — same-UTC-day short-circuit if today's chain
//      already reached success; otherwise resume from prior partial's
//      last_processed_fan_edit_id, or start a fresh run.
//   2. Query active fan_edits where last_refreshed_at is null OR older
//      than REFRESH_INTERVAL_HOURS, ordered by id ascending, filtered
//      to id > prior cursor, limited to MAX_FAN_EDITS_PER_INVOCATION.
//   3. Per fan_edit:
//        - fetchEngagementMetrics
//        - on success: write snapshot + update fan_edits counts +
//          reset failure count
//        - on not_found / private: increment failure count, possibly
//          mark dead at threshold (no snapshot)
//        - on rate_limited: STOP and return partial; cron picks up
//          next tick
//        - on transient / parse_error: SKIP without state change (not
//          the post's fault)
//        - update progress on the run row after each fan_edit
//   4. After loop:
//        - if exited early via rate_limited or budget → partial
//        - if returned MAX rows → partial (more work pending)
//        - else (drained) → success
//
// Constants tuned conservatively. Daily volume today is 6 fan_edits;
// caps are sized for catalog growth.

import {
  createClient,
  type SupabaseClient,
} from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { fetchEngagementMetrics } from "./ensemble.ts";
import {
  handleFailure,
  writeSnapshotAndUpdateFanEdit,
} from "./upsert.ts";
import {
  finalizeRun,
  loadOrStartRun,
  type RunCounters,
  updateRunProgress,
} from "./checkpoint.ts";

const MAX_FAN_EDITS_PER_INVOCATION = 100;
const WALL_CLOCK_BUDGET_MS = 25_000;
const FAILURE_THRESHOLD_TO_MARK_DEAD = 3;
const REFRESH_INTERVAL_HOURS = 20;

function getEnv(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function jsonResponse(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (_req: Request) => {
  const startTime = Date.now();

  // Fail fast on missing token. The token is also checked inside
  // ensemble.ts (returns 'transient' if missing), but checking here
  // gives a clearer error than the per-fan-edit transient cascade.
  if (!Deno.env.get("ENSEMBLEDATA_TOKEN")) {
    return jsonResponse(
      {
        run_id: null,
        status: "failed",
        fan_edits_processed: 0,
        fan_edits_succeeded: 0,
        fan_edits_failed: 0,
        fan_edits_dead_marked: 0,
        duration_ms: Date.now() - startTime,
        error_message: "ENSEMBLEDATA_TOKEN env var missing",
      },
      500,
    );
  }

  let supabase: SupabaseClient | null = null;
  let runId: string | null = null;
  let lastProcessed: string | null = null;
  const counters: RunCounters = {
    fan_edits_processed: 0,
    fan_edits_succeeded: 0,
    fan_edits_failed: 0,
    fan_edits_dead_marked: 0,
  };

  try {
    supabase = createClient(
      getEnv("SUPABASE_URL"),
      getEnv("SUPABASE_SERVICE_ROLE_KEY"),
      { auth: { persistSession: false, autoRefreshToken: false } },
    );

    const state = await loadOrStartRun(supabase, WALL_CLOCK_BUDGET_MS);

    if (state.alreadyCompleted) {
      return jsonResponse({
        run_id: null,
        status: "success",
        already_completed_today: true,
        most_recent_run_id: state.previousRunId,
        fan_edits_processed: 0,
        fan_edits_succeeded: 0,
        fan_edits_failed: 0,
        fan_edits_dead_marked: 0,
        duration_ms: Date.now() - startTime,
        error_message: null,
      });
    }

    if (!state.runId) {
      throw new Error(
        "[view-tracking] internal: loadOrStartRun returned null runId without alreadyCompleted",
      );
    }
    runId = state.runId;
    lastProcessed = state.lastProcessedFanEditId;

    // Query "due to refresh" fan_edits.
    const refreshCutoff = new Date(
      Date.now() - REFRESH_INTERVAL_HOURS * 60 * 60 * 1000,
    ).toISOString();

    let query = supabase
      .from("fan_edits")
      .select("id, platform, embed_url")
      .eq("view_tracking_status", "active")
      .or(
        `last_refreshed_at.is.null,last_refreshed_at.lt.${refreshCutoff}`,
      )
      .order("id", { ascending: true })
      .limit(MAX_FAN_EDITS_PER_INVOCATION);
    if (lastProcessed) {
      query = query.gt("id", lastProcessed);
    }

    const { data: fanEdits, error: queryErr } = await query;
    if (queryErr) {
      throw new Error(
        `[view-tracking] fan_edits query failed: ${queryErr.message}`,
      );
    }

    if (!fanEdits || fanEdits.length === 0) {
      // Nothing due — chain is drained for today. Mark success.
      await finalizeRun(supabase, runId, "success", counters, lastProcessed, null);
      return jsonResponse({
        run_id: runId,
        status: "success",
        ...counters,
        duration_ms: Date.now() - startTime,
        error_message: null,
      });
    }

    let earlyExitReason: "rate_limited" | "wall_clock_budget" | null = null;

    for (const fe of fanEdits) {
      // Wall-clock budget check before each fan_edit.
      if (Date.now() - startTime > WALL_CLOCK_BUDGET_MS) {
        earlyExitReason = "wall_clock_budget";
        break;
      }

      const result = await fetchEngagementMetrics({
        platform: fe.platform as string,
        embed_url: fe.embed_url as string,
      });

      counters.fan_edits_processed += 1;

      if (result.error === null) {
        try {
          await writeSnapshotAndUpdateFanEdit(supabase, fe.id as string, {
            view_count: result.view_count,
            like_count: result.like_count,
            comment_count: result.comment_count,
            share_count: result.share_count,
            raw_payload: result.raw_payload,
          });
          counters.fan_edits_succeeded += 1;
        } catch (err) {
          counters.fan_edits_failed += 1;
          console.error(
            `[view-tracking] write failed for ${fe.id}: ${
              err instanceof Error ? err.message : err
            }`,
          );
        }
      } else if (
        result.error === "not_found" || result.error === "private"
      ) {
        try {
          const { markedDead } = await handleFailure(
            supabase,
            fe.id as string,
            result.error,
            FAILURE_THRESHOLD_TO_MARK_DEAD,
          );
          counters.fan_edits_failed += 1;
          if (markedDead) counters.fan_edits_dead_marked += 1;
        } catch (err) {
          console.error(
            `[view-tracking] handleFailure failed for ${fe.id}: ${
              err instanceof Error ? err.message : err
            }`,
          );
        }
      } else if (result.error === "rate_limited") {
        // Stop — exit partial without advancing cursor through this
        // fan_edit. The next invocation reprocesses it.
        console.warn(
          `[view-tracking] RATE_LIMITED at fan_edit_id=${fe.id}; exiting partial`,
        );
        earlyExitReason = "rate_limited";
        break;
      } else {
        // 'transient' or 'parse_error' — skip without state change.
        // (Not the post's fault; don't increment failure_count.)
        console.warn(
          `[view-tracking] SKIPPED fan_edit_id=${fe.id} reason=${result.error}`,
        );
      }

      lastProcessed = fe.id as string;
      await updateRunProgress(supabase, runId, counters, lastProcessed);
    }

    if (earlyExitReason) {
      await finalizeRun(
        supabase,
        runId,
        "partial",
        counters,
        lastProcessed,
        `early exit: ${earlyExitReason}`,
      );
      return jsonResponse({
        run_id: runId,
        status: "partial",
        early_exit_reason: earlyExitReason,
        ...counters,
        duration_ms: Date.now() - startTime,
        error_message: null,
      });
    }

    // Loop completed. If we hit the per-invocation cap, more work may
    // remain; mark partial so the next tick continues. If we processed
    // fewer than the cap, we drained the queue → success.
    if (fanEdits.length === MAX_FAN_EDITS_PER_INVOCATION) {
      await finalizeRun(
        supabase,
        runId,
        "partial",
        counters,
        lastProcessed,
        null,
      );
      return jsonResponse({
        run_id: runId,
        status: "partial",
        early_exit_reason: "max_per_invocation",
        ...counters,
        duration_ms: Date.now() - startTime,
        error_message: null,
      });
    }

    await finalizeRun(supabase, runId, "success", counters, lastProcessed, null);
    return jsonResponse({
      run_id: runId,
      status: "success",
      ...counters,
      duration_ms: Date.now() - startTime,
      error_message: null,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[view-tracking] fatal:", msg);
    if (supabase && runId) {
      try {
        await finalizeRun(
          supabase,
          runId,
          "failed",
          counters,
          lastProcessed,
          msg,
        );
      } catch (finalizeErr) {
        console.error(
          "[view-tracking] failed to finalize on fatal:",
          finalizeErr,
        );
      }
    }
    return jsonResponse(
      {
        run_id: runId,
        status: "failed",
        ...counters,
        duration_ms: Date.now() - startTime,
        error_message: msg,
      },
      500,
    );
  }
});
