-- View tracking pipeline schema extensions.
--
-- Prepares view_tracking_snapshots and fan_edits for the upcoming
-- view-tracking Edge Function (parallel to Block D's catalog-freshness
-- pattern). Applied now ahead of build so the function code can rely
-- on the columns from day one — every column we don't add now becomes
-- a future migration against more populated tables.
--
-- view_tracking_snapshots additions:
--   comment_count, share_count — engagement signals beyond
--     view/like; available from EnsembleData responses.
--   source — provenance of the snapshot. Default 'ensembledata' for
--     the planned cron pipeline; 'manual' for hand-entered counts;
--     'oembed' for the simpler YouTube-only fallback path; 'platform_api'
--     reserved for the day we wire direct platform APIs (TikTok
--     Display, Instagram Graph) instead of EnsembleData.
--   raw_payload — jsonb dump of the upstream response. Forensic only;
--     keeps a trail when EnsembleData's shape drifts or a snapshot
--     looks anomalous.
--
-- (fan_edit_id, captured_at desc) index — the natural query is
-- "latest snapshot per fan_edit" and "snapshot history for fan_edit
-- ordered most-recent-first." Same shape as the catalog_sync_runs
-- (started_at desc) index from Block D.
--
-- fan_edits additions:
--   comment_count, share_count — denormalized current values
--     mirroring view_count/like_count. Title-page UI reads these,
--     not snapshot history.
--   view_tracking_status — lifecycle state for the cron picker.
--     'active' is the default (refresh on schedule). After repeated
--     failures or a delete-detect, the cron flips it to
--     'deleted_from_platform' / 'private' / 'failed' so the picker
--     skips it. A separate admin flow can reactivate after manual
--     review.
--   view_tracking_failure_count — counter for consecutive refresh
--     failures. The cron uses it to decide when to flip status.
--
-- Partial index on (view_tracking_status, last_refreshed_at) where
-- status='active' — the cron's "due to refresh" picker scans this
-- index, ordering by oldest last_refreshed_at first. Inactive rows
-- are excluded from the index entirely (no scan cost as the dead-
-- tracking set grows).

alter table public.view_tracking_snapshots
  add column if not exists comment_count integer,
  add column if not exists share_count integer,
  add column if not exists source text not null default 'ensembledata'
    check (source in ('ensembledata', 'manual', 'oembed', 'platform_api')),
  add column if not exists raw_payload jsonb;

create index if not exists idx_vts_fan_edit_captured
  on public.view_tracking_snapshots (fan_edit_id, captured_at desc);

alter table public.fan_edits
  add column if not exists comment_count integer not null default 0,
  add column if not exists share_count integer not null default 0,
  add column if not exists view_tracking_status text not null default 'active'
    check (view_tracking_status in ('active', 'deleted_from_platform', 'private', 'failed')),
  add column if not exists view_tracking_failure_count integer not null default 0;

create index if not exists idx_fan_edits_tracking_due
  on public.fan_edits (view_tracking_status, last_refreshed_at)
  where view_tracking_status = 'active';

-- Defensive check on view_tracking_snapshots.fan_edit_id ON DELETE
-- rule. The pipeline assumes CASCADE: deleting a fan_edit should
-- drop its snapshot history rather than orphan it. This block
-- inspects the current rule and emits a NOTICE for the operator — it
-- does NOT auto-alter the constraint, since changing FK rules on a
-- populated table deserves human review.
do $$
declare
  current_rule text;
begin
  select rc.delete_rule into current_rule
  from information_schema.referential_constraints rc
  join information_schema.key_column_usage kcu
    on kcu.constraint_name = rc.constraint_name
  where kcu.table_schema = 'public'
    and kcu.table_name = 'view_tracking_snapshots'
    and kcu.column_name = 'fan_edit_id';

  if current_rule is distinct from 'CASCADE' then
    raise notice 'view_tracking_snapshots.fan_edit_id FK is %, not CASCADE - manual review needed', coalesce(current_rule, 'NOT FOUND');
  else
    raise notice 'view_tracking_snapshots.fan_edit_id FK is CASCADE, no change needed';
  end if;
end $$;
