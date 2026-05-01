-- Add oembed columns to fan_edits.
-- creator_handle_displayed already added in 20260427000003_alter_fan_edits_for_v9.sql
-- (kept here under "if not exists" so re-runs are safe).

alter table public.fan_edits
  add column if not exists thumbnail_url text,
  add column if not exists creator_handle_displayed text,
  add column if not exists oembed_fetched_at timestamptz;

-- Index for finding rows that still need an oembed fetch.
create index if not exists idx_fan_edits_oembed_pending
  on public.fan_edits (oembed_fetched_at)
  where oembed_fetched_at is null;
