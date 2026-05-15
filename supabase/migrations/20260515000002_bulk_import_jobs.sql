-- Admin bulk fan-edit CSV import jobs.
--
-- The bulk commit flow can take 30-90s for 100 rows because each row
-- needs a serial EnsembleData call. Rather than block the HTTP
-- response for that long, /api/admin/fan-edits/bulk/commit creates a
-- row here, fires after() to process, and returns the job_id
-- immediately. The client polls GET /jobs/[id] every ~2s for
-- progress + final outcome.
--
-- rows is the full ordered preview payload AND per-row outcome. The
-- /commit route writes input + status='pending' on insert; the
-- background processor updates outcome fields per row as it goes.

create table public.bulk_import_jobs (
  id uuid primary key default gen_random_uuid(),
  -- Super-admin who kicked off the job. References users(id) rather
  -- than auth.users since the app reads from public.users.
  user_id uuid not null references public.users(id) on delete cascade,
  status text not null default 'pending' check (
    status in ('pending', 'processing', 'completed', 'failed')
  ),
  total_rows integer not null default 0,
  processed_rows integer not null default 0,
  succeeded_count integer not null default 0,
  failed_count integer not null default 0,
  skipped_count integer not null default 0,
  -- JSONB array of per-row objects. Each row:
  --   { idx, embed_url, platform, content_id, handle, title_id,
  --     title_name, notes, skip, outcome:'pending'|'ok'|'failed'|'skipped',
  --     reason }
  rows jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index bulk_import_jobs_user_id_created_at_idx
  on public.bulk_import_jobs (user_id, created_at desc);

alter table public.bulk_import_jobs enable row level security;

-- Super-admin reads only. The route is service-role for writes;
-- end-user clients should never touch this table directly.
create policy "Super-admin selects bulk_import_jobs"
  on public.bulk_import_jobs
  for select
  to authenticated
  using (
    exists (
      select 1 from public.users u
      where u.id = auth.uid() and u.role = 'super_admin'
    )
  );

comment on table public.bulk_import_jobs is
  'Async progress + per-row outcome for admin bulk fan-edit CSV uploads. /commit creates the row + after(); /jobs/[id] polls.';
