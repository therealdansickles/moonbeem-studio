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

export type SnapshotMetrics = {
  view_count: number | null;
  like_count: number | null;
  comment_count: number | null;
  share_count: number | null;
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

  // Denormalized counts on fan_edits use 0 fallback when the upstream
  // returned null (the columns are NOT NULL with default 0). The
  // snapshot row above preserves the actual null for forensic accuracy.
  const update = await supabase
    .from("fan_edits")
    .update({
      view_count: metrics.view_count ?? 0,
      like_count: metrics.like_count ?? 0,
      comment_count: metrics.comment_count ?? 0,
      share_count: metrics.share_count ?? 0,
      last_refreshed_at: new Date().toISOString(),
      view_tracking_failure_count: 0,
    })
    .eq("id", fanEditId);
  if (update.error) {
    throw new Error(
      `[view-tracking] fan_edit update failed for ${fanEditId}: ${update.error.message}`,
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
