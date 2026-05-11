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
  const update: Record<string, unknown> = {
    view_count: metrics.view_count ?? 0,
    like_count: metrics.like_count ?? 0,
    comment_count: metrics.comment_count ?? 0,
    share_count: metrics.share_count ?? 0,
    duration_seconds: metrics.duration_seconds,
    aspect_ratio: metrics.aspect_ratio,
    last_refreshed_at: new Date().toISOString(),
    view_tracking_failure_count: 0,
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
