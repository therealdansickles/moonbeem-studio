-- Step 1.5 — view-tracking error-aware backoff schema.
--
-- Adds the dedicated ladder counter + backoff gate on fan_edits (isolated from
-- view_tracking_failure_count, which stays handleFailure's not_found/private death
-- evidence so a spurious 404 can't instant-kill a high-parse_error row), plus the
-- two observability counters on view_tracking_runs. 'failed' already exists in the
-- view_tracking_status CHECK (20260505000005) so the parse_error death needs no
-- constraint change.

alter table public.fan_edits
  add column if not exists refresh_failure_count integer not null default 0,
  add column if not exists refresh_backoff_until timestamptz;

-- Serves the due-query backoff gate: active rows whose backoff window is set.
create index if not exists idx_fan_edits_refresh_backoff
  on public.fan_edits (refresh_backoff_until)
  where view_tracking_status = 'active' and refresh_backoff_until is not null;

alter table public.view_tracking_runs
  add column if not exists rows_backed_off integer not null default 0,
  add column if not exists rows_marked_failed integer not null default 0;
