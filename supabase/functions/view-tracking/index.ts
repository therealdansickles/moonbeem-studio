// view-tracking Edge Function — daily refresh of fan_edit engagement
// metrics via EnsembleData.
//
// Orchestration (catalog-freshness pattern):
//   1. loadOrStartRun — same-UTC-day short-circuit if today's chain
//      already drained AND nothing is currently eligible; otherwise
//      open a fresh run row.
//   2. Query active fan_edits where last_refreshed_at IS NULL OR
//      older than REFRESH_INTERVAL_HOURS, ordered by last_refreshed_at
//      ASC NULLS FIRST, limited to MAX_FAN_EDITS_PER_INVOCATION.
//      No cursor filter — the eligibility window itself is the
//      "what's left to do" signal. Successfully refreshed rows fall
//      out of the window; transient/parse_error skips leave
//      last_refreshed_at unchanged so they stay at the front of the
//      next invocation's queue. (Replaces the prior UUID-cursor
//      design which silently dropped rows when the cursor advanced
//      past a transient skip — see incidents on 2026-05-06/07.)
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
  markRefreshFailed,
  recordRefreshError,
  setShortBackoff,
  writeSnapshotAndUpdateFanEdit,
} from "./upsert.ts";
import {
  finalizeRun,
  loadOrStartRun,
  type RunCounters,
  updateRunProgress,
} from "./checkpoint.ts";
import { groupFanEditsByPost } from "./group.ts";
import {
  deathProceeds,
  isParseDeathCandidate,
  RATE_LIMITED_BACKOFF_MS,
} from "./backoff.ts";

const MAX_FAN_EDITS_PER_INVOCATION = 100;
const WALL_CLOCK_BUDGET_MS = 60_000;
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
    rows_backed_off: 0,
    rows_marked_failed: 0,
  };
  // Parse_error rows that crossed the death threshold this run; the trailing-success
  // breaker is applied to them after the loop (deferred so it sees fresh successes).
  const deathCandidates: { id: string; platform: string; reason: string }[] = [];

  try {
    supabase = createClient(
      getEnv("SUPABASE_URL"),
      getEnv("SUPABASE_SERVICE_ROLE_KEY"),
      { auth: { persistSession: false, autoRefreshToken: false } },
    );

    const state = await loadOrStartRun(
      supabase,
      WALL_CLOCK_BUDGET_MS,
      REFRESH_INTERVAL_HOURS,
    );

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

    // Query "due to refresh" fan_edits ordered by last_refreshed_at
    // ASC NULLS FIRST. Never-refreshed rows (NULL) come first, then
    // oldest-stale. No cursor filter — see header comment.
    const refreshCutoff = new Date(
      Date.now() - REFRESH_INTERVAL_HOURS * 60 * 60 * 1000,
    ).toISOString();
    const nowIso = new Date().toISOString();

    // YouTube refresh re-enabled 2026-05-11 via YT Data API v3
    // (env: YOUTUBE_API_KEY). fetchEngagementMetrics dispatches
    // YT rows to fetchYouTubeMetrics; EnsembleData handles the rest.
    //
    // Step 1.5: the second .or() is the error-backoff gate — a row that recently
    // failed sits out until its refresh_backoff_until elapses (the two .or() groups
    // are AND-combined). Rows that never failed have a null backoff and pass freely.
    const { data: fanEdits, error: queryErr } = await supabase
      .from("fan_edits")
      .select("id, platform, embed_url, post_id")
      .eq("view_tracking_status", "active")
      .or(
        `last_refreshed_at.is.null,last_refreshed_at.lt.${refreshCutoff}`,
      )
      .or(
        `refresh_backoff_until.is.null,refresh_backoff_until.lte.${nowIso}`,
      )
      .order("last_refreshed_at", { ascending: true, nullsFirst: true })
      .limit(MAX_FAN_EDITS_PER_INVOCATION);
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

    // Group by post so we fetch EnsembleData ONCE per unique post and fan the
    // identical stats out to every fan_edit sharing it (N fetches -> 1). The
    // per-row writes below are unchanged, so stored values are byte-identical to
    // the old per-row path — this is an equivalence-preserving cost fix. See group.ts.
    const groups = groupFanEditsByPost(
      fanEdits as {
        id: string;
        platform: string;
        embed_url: string;
        post_id: string | null;
      }[],
    );

    for (const group of groups) {
      // Wall-clock budget check before each post.
      if (Date.now() - startTime > WALL_CLOCK_BUDGET_MS) {
        earlyExitReason = "wall_clock_budget";
        break;
      }

      // ONE fetch per post.
      const result = await fetchEngagementMetrics({
        platform: group.platform,
        embed_url: group.embed_url,
      });

      if (result.error === "rate_limited") {
        // Stop — none of this post's rows are advanced (last_refreshed_at untouched).
        // rate_limited is inert (spec §2): give the throttled row(s) only a short
        // backoff so they aren't first to re-hit next run — no counter, no death.
        console.warn(
          `[view-tracking] RATE_LIMITED at post ${group.embed_url}; exiting partial`,
        );
        for (const feId of group.ids) {
          await setShortBackoff(supabase, feId, RATE_LIMITED_BACKOFF_MS);
        }
        earlyExitReason = "rate_limited";
        break;
      }

      // Fan the single result out to every fan_edit sharing this post. Each row
      // still gets its own snapshot + counter update (per-row semantics preserved).
      for (const feId of group.ids) {
        counters.fan_edits_processed += 1;

        if (result.error === null) {
          try {
            await writeSnapshotAndUpdateFanEdit(supabase, feId, {
              view_count: result.view_count,
              like_count: result.like_count,
              comment_count: result.comment_count,
              share_count: result.share_count,
              thumbnail_url: result.thumbnail_url,
              duration_seconds: result.duration_seconds,
              aspect_ratio: result.aspect_ratio,
              creator_handle_displayed: result.creator_handle_displayed,
              posted_at: result.posted_at,
              raw_payload: result.raw_payload,
            });
            counters.fan_edits_succeeded += 1;
          } catch (err) {
            counters.fan_edits_failed += 1;
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[view-tracking] write failed for ${feId}: ${msg}`);
            // Surface the write_failed reason on fan_edits so it's queryable
            // without trawling Edge Function logs. Best-effort.
            try {
              await recordRefreshError(supabase, feId, `write_failed: ${msg}`);
              counters.rows_backed_off += 1;
            } catch (recErr) {
              console.error(
                `[view-tracking] recordRefreshError after write_failed for ${feId}: ${
                  recErr instanceof Error ? recErr.message : recErr
                }`,
              );
            }
          }
        } else if (result.error === "not_found" || result.error === "private") {
          try {
            const { markedDead } = await handleFailure(
              supabase,
              feId,
              result.error,
              FAILURE_THRESHOLD_TO_MARK_DEAD,
            );
            counters.fan_edits_failed += 1;
            if (markedDead) counters.fan_edits_dead_marked += 1;
          } catch (err) {
            console.error(
              `[view-tracking] handleFailure failed for ${feId}: ${
                err instanceof Error ? err.message : err
              }`,
            );
          }
        } else {
          // 'transient' or 'parse_error' — skip without changing
          // last_refreshed_at or failure_count (not the post's fault). Record the
          // per-row error so silent-skip classes stay queryable from fan_edits.
          console.warn(
            `[view-tracking] SKIPPED fan_edit_id=${feId} reason=${result.error}`,
          );
          const reason =
            `${result.error}: ${group.platform} fetch returned ${result.error}`;
          try {
            const { newCount } = await recordRefreshError(supabase, feId, reason);
            counters.rows_backed_off += 1;
            // Only parse_error escalates. Collect the candidate for the post-loop
            // trailing-success breaker (deferred so it sees this run's successes).
            if (isParseDeathCandidate(result.error, newCount)) {
              deathCandidates.push({ id: feId, platform: group.platform, reason });
            }
          } catch (recErr) {
            console.error(
              `[view-tracking] recordRefreshError after ${result.error} for ${feId}: ${
                recErr instanceof Error ? recErr.message : recErr
              }`,
            );
          }
        }

        lastProcessed = feId;
      }

      await updateRunProgress(supabase, runId, counters, lastProcessed);
    }

    // Death sweep with the trailing-success breaker (spec §4). Deferred to here so
    // successes_24h includes this run's fresh refreshes. Per candidate platform: death
    // proceeds iff >=5 successful refreshes in the last 24h OR <5 active rows; else
    // suppressed (candidates keep their 24h backoff, re-evaluated next run). Runs on
    // both normal completion and early exit, over whatever candidates were collected.
    if (deathCandidates.length > 0) {
      const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const platforms = [...new Set(deathCandidates.map((c) => c.platform))];
      for (const platform of platforms) {
        const platCandidates = deathCandidates.filter((c) => c.platform === platform);
        const { count: successes24h } = await supabase
          .from("fan_edits")
          .select("id", { count: "exact", head: true })
          .eq("view_tracking_status", "active")
          .eq("platform", platform)
          .gte("last_refreshed_at", cutoff24h);
        const { count: activeCount } = await supabase
          .from("fan_edits")
          .select("id", { count: "exact", head: true })
          .eq("view_tracking_status", "active")
          .eq("platform", platform);
        if (!deathProceeds(successes24h ?? 0, activeCount ?? 0)) {
          console.warn(
            `[view-tracking] DEATH_SUPPRESSED platform=${platform} successes_24h=${
              successes24h ?? 0
            } active=${activeCount ?? 0} candidates=${platCandidates.length}`,
          );
          continue;
        }
        for (const c of platCandidates) {
          try {
            await markRefreshFailed(supabase, c.id);
            counters.rows_marked_failed += 1;
            console.log(
              `[view-tracking] MARKED_FAILED fan_edit_id=${c.id} platform=${c.platform} reason=${c.reason}`,
            );
          } catch (err) {
            console.error(
              `[view-tracking] markRefreshFailed failed for ${c.id}: ${
                err instanceof Error ? err.message : err
              }`,
            );
          }
        }
      }
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
