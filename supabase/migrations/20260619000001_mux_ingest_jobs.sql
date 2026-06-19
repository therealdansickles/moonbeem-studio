-- Mux U2 (Part 1) — mux_ingest_jobs: async tracking for a Mux direct-upload from
-- creation → ready. Pure Postgres, zero Mux dependency, money-rail-free.
--
-- WHY a separate table: title_episodes keeps its U1 invariant — a mux row exists
-- ONLY when playable (mux_playback_id present). An in-flight upload has no
-- playback_id yet, so it lives here. The video.asset.ready webhook reads the
-- playback id from the event payload and inserts the title_episodes row at that
-- moment; this job table tracks everything up to that point. Mirrors the house
-- async-job pattern (bulk_import_jobs, letterboxd_import_jobs, catalog_sync_runs).
--
-- Status machine (CHECK):
--   creating        — job row created; direct-upload URL not yet returned by Mux
--   awaiting_upload — upload URL returned; waiting for the file + encode
--   encoding        — video.upload.asset_created fired; asset exists, encoding
--   ready           — video.asset.ready fired; title_episodes row inserted
--   errored         — video.asset.errored / upload error reported by Mux
-- 'canceled' is intentionally OMITTED: there is no cancel path in v1, so we don't
-- model a state nothing can produce. Add it when a cancel UI/route exists.

create table if not exists public.mux_ingest_jobs (
  id uuid primary key default gen_random_uuid(),
  title_id uuid not null references public.titles(id) on delete cascade,
  intended_episode_number integer,             -- episode_number the resulting title_episodes row will get
  intended_label text,
  mux_upload_id text,                           -- Mux direct-upload id (set at creation)
  mux_asset_id text,                            -- set when video.upload.asset_created links upload→asset
  mux_playback_id text,                         -- set when video.asset.ready delivers it
  requires_drm boolean not null default true,   -- DRM-first; mirrors title_episodes.requires_drm
  status text not null default 'creating' check (
    status in ('creating','awaiting_upload','encoding','ready','errored')
  ),
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- jobs-by-title (cascade target + the natural lookup)
create index if not exists idx_mux_ingest_jobs_title on public.mux_ingest_jobs (title_id);
-- find in-flight / stuck / errored jobs by status (small table; plain index)
create index if not exists idx_mux_ingest_jobs_status on public.mux_ingest_jobs (status);

-- house updated_at trigger (matches letterboxd_import_jobs / title_episodes)
drop trigger if exists set_updated_at_mux_ingest_jobs on public.mux_ingest_jobs;
create trigger set_updated_at_mux_ingest_jobs
  before update on public.mux_ingest_jobs
  for each row execute function public.set_updated_at();

-- RLS: enabled, ZERO policies — service-role only (mirrors title_episodes). The
-- ingest route + webhook write via the service-role client; no client touches this.
alter table public.mux_ingest_jobs enable row level security;

comment on table public.mux_ingest_jobs is
  'Async tracking for a Mux direct-upload (creating→awaiting_upload→encoding→ready/errored). video.asset.ready inserts the title_episodes row from the webhook payload. Service-role only.';
