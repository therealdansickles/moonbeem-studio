// Snapshot writer + fan_edits state updater for the view-tracking
// pipeline.
//
// Two paths:
//   writeSnapshotAndUpdateFanEdit — success path. Inserts a row in
//     view_tracking_snapshots with full metrics + raw_payload, then
//     updates the denormalized counts on fan_edits, refreshes
//     last_refreshed_at, and resets view_tracking_failure_count to
//     zero.
//
//   handleFailure — not_found / private path. Increments the failure
//     counter on fan_edits. If the new count crosses
//     FAILURE_THRESHOLD_TO_MARK_DEAD, flips view_tracking_status to
//     'deleted_from_platform' (for not_found) or 'private' (for
//     private). Returns whether the row was just marked dead so the
//     orchestrator can bump its run-level counter.
//
// transient and parse_error don't reach this module — orchestrator
// skips those without state changes per the Block D pattern.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { rehostThumbnail } from "./r2-upload.ts";
import { ladderBackoffMs } from "./backoff.ts";

export type SnapshotMetrics = {
  view_count: number | null;
  like_count: number | null;
  comment_count: number | null;
  share_count: number | null;
  thumbnail_url: string | null;
  duration_seconds: number | null;
  aspect_ratio: string | null;
  creator_handle_displayed: string | null;
  posted_at: string | null;
  raw_payload: unknown | null;
};

export async function writeSnapshotAndUpdateFanEdit(
  supabase: SupabaseClient,
  fanEditId: string,
  metrics: SnapshotMetrics,
): Promise<void> {
  const snap = await supabase
    .from("view_tracking_snapshots")
    .insert({
      fan_edit_id: fanEditId,
      view_count: metrics.view_count,
      like_count: metrics.like_count,
      comment_count: metrics.comment_count,
      share_count: metrics.share_count,
      raw_payload: metrics.raw_payload,
      source: "ensembledata",
    });
  if (snap.error) {
    throw new Error(
      `[view-tracking] snapshot insert failed for ${fanEditId}: ${snap.error.message}`,
    );
  }

  // Read current thumbnail_source AND creator_handle_displayed so we
  // know whether to overwrite each. Rules (both first-write-wins):
  //   - thumbnail_url: only overwrite when thumbnail_source is NULL
  //     or 'oembed'. If 'ensembledata' or some future tag (manual
  //     override), leave alone.
  //   - creator_handle_displayed: only set when currently NULL.
  //     Once any value lands (ingest-time parse or EnsembleData),
  //     don't overwrite.
  //   - posted_at: only set when currently NULL (first-write-wins).
  //     YouTube refresh backfills from snippet.publishedAt — other
  //     platforms leave null since EnsembleData doesn't surface
  //     posted_at reliably on per-post lookups.
  const existing = await supabase
    .from("fan_edits")
    .select("thumbnail_source, creator_handle_displayed, posted_at")
    .eq("id", fanEditId)
    .single();
  if (existing.error || !existing.data) {
    throw new Error(
      `[view-tracking] failed to read thumbnail_source for ${fanEditId}: ${
        existing.error?.message ?? "no row"
      }`,
    );
  }
  const currentSource =
    (existing.data.thumbnail_source as string | null) ?? null;
  const currentHandle =
    (existing.data.creator_handle_displayed as string | null) ?? null;
  const currentPostedAt =
    (existing.data.posted_at as string | null) ?? null;
  const shouldUpdateThumb =
    metrics.thumbnail_url !== null &&
    (currentSource === null || currentSource === "oembed");
  const shouldSetHandle =
    metrics.creator_handle_displayed !== null && currentHandle === null;
  const shouldSetPostedAt =
    metrics.posted_at !== null && currentPostedAt === null;

  // Denormalized counts on fan_edits use 0 fallback when the upstream
  // returned null (the columns are NOT NULL with default 0). The
  // snapshot row above preserves the actual null for forensic accuracy.
  // duration_seconds and aspect_ratio are EnsembleData-only and always
  // updated (no oEmbed conflict to worry about).
  // last_refresh_error / _at cleared so stale error state from prior
  // ticks (silent-skip parse_error, transient fetch, write_failed)
  // doesn't outlive recovery; NULL = no error currently recorded.
  const update: Record<string, unknown> = {
    view_count: metrics.view_count ?? 0,
    like_count: metrics.like_count ?? 0,
    comment_count: metrics.comment_count ?? 0,
    share_count: metrics.share_count ?? 0,
    duration_seconds: metrics.duration_seconds,
    aspect_ratio: metrics.aspect_ratio,
    last_refreshed_at: new Date().toISOString(),
    view_tracking_failure_count: 0,
    last_refresh_error: null,
    last_refresh_error_at: null,
    // Step 1.5: a successful refresh clears BOTH failure counters + the backoff.
    refresh_failure_count: 0,
    refresh_backoff_until: null,
  };
  if (shouldUpdateThumb && metrics.thumbnail_url) {
    // Re-host on R2 so we own the asset. Platform CDN URLs (Instagram
    // fiev14 especially) sign and expire; R2 is stable. On upload
    // failure, log and skip the thumbnail update entirely so the
    // first-write-wins gate stays open for retry on the next refresh.
    try {
      const r2Url = await rehostThumbnail(fanEditId, metrics.thumbnail_url);
      update.thumbnail_url = r2Url;
      update.thumbnail_source_url = metrics.thumbnail_url;
      update.thumbnail_source = "ensembledata";
    } catch (err) {
      console.error(
        `[view-tracking] r2 rehost failed for ${fanEditId} (source ${
          metrics.thumbnail_url
        }): ${err instanceof Error ? err.message : err}`,
      );
      // Intentionally don't set thumbnail_url/source/source_url —
      // next refresh will retry since thumbnail_source stays at
      // its current value (NULL or 'oembed').
    }
  }
  if (shouldSetHandle) {
    update.creator_handle_displayed = metrics.creator_handle_displayed;
  }
  if (shouldSetPostedAt) {
    update.posted_at = metrics.posted_at;
  }

  const updateResult = await supabase
    .from("fan_edits")
    .update(update)
    .eq("id", fanEditId);
  if (updateResult.error) {
    throw new Error(
      `[view-tracking] fan_edit update failed for ${fanEditId}: ${updateResult.error.message}`,
    );
  }
}

export type DeadCategory = "deleted_from_platform" | "private";

export async function handleFailure(
  supabase: SupabaseClient,
  fanEditId: string,
  errorCategory: "not_found" | "private",
  failureThreshold: number,
): Promise<{ markedDead: boolean; newFailureCount: number }> {
  const read = await supabase
    .from("fan_edits")
    .select("view_tracking_failure_count")
    .eq("id", fanEditId)
    .single();
  if (read.error || !read.data) {
    throw new Error(
      `[view-tracking] failed to read failure_count for ${fanEditId}: ${
        read.error?.message ?? "no row"
      }`,
    );
  }
  const newCount = (read.data.view_tracking_failure_count as number) + 1;
  const shouldMarkDead = newCount >= failureThreshold;
  const newStatus: DeadCategory | null = shouldMarkDead
    ? errorCategory === "not_found" ? "deleted_from_platform" : "private"
    : null;

  const updates: Record<string, unknown> = {
    view_tracking_failure_count: newCount,
  };
  if (newStatus) updates.view_tracking_status = newStatus;

  const upd = await supabase
    .from("fan_edits")
    .update(updates)
    .eq("id", fanEditId);
  if (upd.error) {
    throw new Error(
      `[view-tracking] handleFailure update failed for ${fanEditId}: ${upd.error.message}`,
    );
  }

  if (shouldMarkDead) {
    console.log(
      `[view-tracking] MARKED_DEAD fan_edit_id=${fanEditId} status=${newStatus} failure_count=${newCount}`,
    );
  }

  return { markedDead: shouldMarkDead, newFailureCount: newCount };
}

// Records a ladder failure (parse_error / transient / write_failed). Increments the
// DEDICATED refresh_failure_count (never view_tracking_failure_count — that stays
// handleFailure's not_found/private evidence, so a stray 404 can't instant-kill a
// high-parse_error row), sets an escalating refresh_backoff_until so the picker stops
// re-trying every tick, and retains the error string. last_refreshed_at is
// intentionally NOT touched — freshness keeps meaning "stats successfully refreshed".
// Returns the new count so the orchestrator can decide parse_error death candidacy.
// Best-effort: caller catches on throw.
export async function recordRefreshError(
  supabase: SupabaseClient,
  fanEditId: string,
  errorString: string,
): Promise<{ newCount: number }> {
  const read = await supabase
    .from("fan_edits")
    .select("refresh_failure_count")
    .eq("id", fanEditId)
    .single();
  if (read.error || !read.data) {
    throw new Error(
      `[view-tracking] failed to read refresh_failure_count for ${fanEditId}: ${
        read.error?.message ?? "no row"
      }`,
    );
  }
  const newCount = (read.data.refresh_failure_count as number) + 1;
  const backoffUntil = new Date(Date.now() + ladderBackoffMs(newCount)).toISOString();
  const upd = await supabase
    .from("fan_edits")
    .update({
      refresh_failure_count: newCount,
      refresh_backoff_until: backoffUntil,
      last_refresh_error: errorString,
      last_refresh_error_at: new Date().toISOString(),
    })
    .eq("id", fanEditId);
  if (upd.error) {
    throw new Error(
      `[view-tracking] recordRefreshError update failed for ${fanEditId}: ${upd.error.message}`,
    );
  }
  return { newCount };
}

// rate_limited is inert (spec §2): only a short backoff so the throttled row isn't
// first to re-hit next run. No counter, no error stamp, no death.
export async function setShortBackoff(
  supabase: SupabaseClient,
  fanEditId: string,
  ms: number,
): Promise<void> {
  const upd = await supabase
    .from("fan_edits")
    .update({ refresh_backoff_until: new Date(Date.now() + ms).toISOString() })
    .eq("id", fanEditId);
  if (upd.error) {
    console.error(
      `[view-tracking] setShortBackoff failed for ${fanEditId}: ${upd.error.message}`,
    );
  }
}

// Marks a chronically-parse_error row dead (spec §3), reusing the existing 'failed'
// status — excluded from the due query, admin-reversible (set 'active' + null both
// counters). The reason stays in last_refresh_error. Called only from the death sweep,
// after the trailing-success breaker passes.
export async function markRefreshFailed(
  supabase: SupabaseClient,
  fanEditId: string,
): Promise<void> {
  const upd = await supabase
    .from("fan_edits")
    .update({ view_tracking_status: "failed" })
    .eq("id", fanEditId);
  if (upd.error) {
    throw new Error(
      `[view-tracking] markRefreshFailed update failed for ${fanEditId}: ${upd.error.message}`,
    );
  }
}
