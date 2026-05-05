-- Catalog freshness sync: per-run history table.
--
-- Written by the catalog-freshness Edge Function (changes-feed only,
-- per the v1 design). One row per Edge Function invocation.
--
-- status lifecycle:
--   running  -> set at top of invocation, before any TMDb work
--   partial  -> exited cleanly at 80% of wall-clock budget; cutoff_token
--               carries resume state for the next invocation
--   success  -> all changes-feed pages drained for the day
--   failed   -> hard error (TMDb 401, schema drift, etc.). error_message
--               populated; do not silently write zero-counts rows
--
-- cutoff_token is jsonb so the function can shape resume state freely
-- (last processed tmdb_id, page number, media_type cursor, all of the
-- above). Keeping it open avoids a schema change every time the resume
-- shape evolves.
--
-- The partial index on status lets resume logic find in-flight runs
-- cheaply via index-only lookup, without scanning the full history.

create table public.catalog_sync_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  status text not null check (status in ('running', 'success', 'partial', 'failed')),
  new_titles_count int not null default 0,
  changed_titles_count int not null default 0,
  failed_titles_count int not null default 0,
  tmdb_changes_pages_fetched int not null default 0,
  cutoff_token jsonb,
  error_message text,
  created_at timestamptz not null default now()
);

create index catalog_sync_runs_started_at_desc
  on public.catalog_sync_runs (started_at desc);

create index catalog_sync_runs_status
  on public.catalog_sync_runs (status)
  where status in ('running', 'partial');

-- RLS: super-admin read-only. Edge Function writes via service role
-- (bypasses RLS). No public/authenticated read access — sync metadata
-- isn't user-facing and may include error details we don't want
-- exposed.
alter table public.catalog_sync_runs enable row level security;

create policy catalog_sync_runs_super_admin_read
  on public.catalog_sync_runs for select
  using (
    exists (
      select 1 from public.users
      where users.id = auth.uid() and users.role = 'super_admin'
    )
  );
