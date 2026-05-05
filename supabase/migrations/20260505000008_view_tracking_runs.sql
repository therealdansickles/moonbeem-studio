-- View tracking pipeline: per-run history table.
--
-- Mirrors the structure of catalog_sync_runs (Block D). Written by
-- the view-tracking Edge Function — one row per invocation. The
-- function uses last_processed_fan_edit_id as the resume cursor for
-- partial chains, the same pattern as catalog_sync_runs.cutoff_token
-- but typed (we know the cursor is always a fan_edit uuid for this
-- pipeline, no need for the open jsonb shape).
--
-- status lifecycle:
--   partial  -> default. Function exited at wall-clock budget OR was
--               rate-limited by EnsembleData. last_processed_fan_edit_id
--               carries the resume position for the next invocation.
--   success  -> all currently-due fan_edits drained for this UTC day.
--   failed   -> hard error (missing token, EnsembleData auth failure,
--               unexpected exception). error_message populated.
--
-- "Currently-due" is computed by the function's per-invocation query:
--   view_tracking_status='active' AND last_refreshed_at IS NULL OR
--   last_refreshed_at < now() - interval '20 hours'
--
-- Counters:
--   fan_edits_processed   — total touched this invocation
--   fan_edits_succeeded   — got fresh metrics + wrote a snapshot
--   fan_edits_failed      — hit transient/parse_error/rate_limited
--   fan_edits_dead_marked — flipped to deleted_from_platform/private
--                           after FAILURE_THRESHOLD_TO_MARK_DEAD
--                           consecutive failures
--
-- cpu_budget_ms records the WALL_CLOCK_BUDGET_MS the run was given,
-- so a future-self reading the row knows whether the partial was
-- because of budget exhaustion vs. rate-limiting.
--
-- Indexes:
--   (status, started_at desc) — admin "recent runs" view, plus the
--     "find a partial to resume from" lookup.
--   partial-only on started_at desc — same query the resume logic
--     runs every invocation; partial index keeps it index-only as
--     the success/failed history grows.

create table public.view_tracking_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  status text not null default 'partial'
    check (status in ('partial', 'success', 'failed')),
  fan_edits_processed integer not null default 0,
  fan_edits_succeeded integer not null default 0,
  fan_edits_failed integer not null default 0,
  fan_edits_dead_marked integer not null default 0,
  last_processed_fan_edit_id uuid
    references public.fan_edits(id) on delete set null,
  cpu_budget_ms integer,
  error_message text,
  notes text
);

create index idx_vtr_status_started
  on public.view_tracking_runs (status, started_at desc);

create index idx_vtr_partial_runs
  on public.view_tracking_runs (started_at desc)
  where status = 'partial';
