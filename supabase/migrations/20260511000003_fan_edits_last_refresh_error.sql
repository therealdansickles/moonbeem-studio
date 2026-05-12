-- Per-row error observability for view-tracking.
--
-- Before today, parse_error and other non-recorded failure paths in the
-- view-tracking Edge Function exited silently — the orchestrator
-- console.warns and skips without state change. That made it
-- non-trivial to spot when a class of rows (e.g. TikTok /photo/ URLs
-- the Edge Function parser couldn't handle) had become unprocessable;
-- the only signal was view_tracking_runs showing succ=0 across ticks
-- and required cross-referencing the picker queue to diagnose.
--
-- These columns make per-row failure directly queryable:
--   SELECT id, embed_url, last_refresh_error, last_refresh_error_at
--   FROM fan_edits
--   WHERE view_tracking_status = 'active'
--     AND last_refresh_error IS NOT NULL;
--
-- Edge Function semantics (per writeSnapshotAndUpdateFanEdit + the
-- orchestrator's skip branches):
--   - On parse_error / transient / other unrecorded failure paths:
--     set last_refresh_error = '<category>: <reason>' + _at = now().
--   - On successful refresh (writeSnapshotAndUpdateFanEdit): clear
--     both columns back to NULL so stale state doesn't outlive
--     recovery.
--   - not_found / private continue to flow through handleFailure
--     (failure_count + eventual mark-dead). Those paths also set
--     last_refresh_error for consistency, even though they're already
--     observable via view_tracking_failure_count + status changes.
--
-- Both columns nullable; no backfill (NULL = no error recorded).

alter table public.fan_edits
  add column if not exists last_refresh_error text,
  add column if not exists last_refresh_error_at timestamptz;
