-- Phase 1 — creator self-serve hosting lane (ruling D1: SEPARATE tables, the
-- titles/partner model stays PURE — nothing here alters titles / title_episodes /
-- mux_ingest_jobs). The creator DRM rail is a full parallel of the partner rail:
--   creator_titles           <- (partner) titles
--   creator_episodes         <- (partner) title_episodes
--   creator_mux_ingest_jobs  <- (partner) mux_ingest_jobs
--   mux_finalize_creator_asset_ready(...) <- mux_finalize_asset_ready(...)
--
-- RLS posture (ruling Q1 = Option A): every table is RLS-ENABLED with ZERO
-- policies (deny-all) — reads/writes go through the service-role client, and
-- authorization lives in the route layer (authorizeCreatorTitleMutation), exactly
-- like title_episodes / mux_ingest_jobs today. NO public SELECT policy is written
-- now: creator titles are dashboard-only in v1 (ruling Q2). Phase 6 defines the
-- real client-read surface and writes the SELECT policies its requirements imply.

-- 1) creator_titles — a creator-owned film. Ownership is the direct creators FK
--    (creators = root identity); slug is a per-creator namespace ("their own
--    catalog namespace"), NOT global, since there is no public URL in v1.
create table public.creator_titles (
  id           uuid primary key default gen_random_uuid(),
  creator_id   uuid not null references public.creators(id) on delete cascade,
  slug         text not null,
  title        text not null,
  synopsis     text,
  poster_url   text,
  requires_drm boolean not null default true,   -- D3: carried from birth, NOT surfaced in v1 UI
  is_public    boolean not null default false,  -- Phase-6 readiness, NOT surfaced in v1 UI
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz,
  constraint creator_titles_creator_slug_unique unique (creator_id, slug)
);
create index idx_creator_titles_creator_id
  on public.creator_titles (creator_id) where deleted_at is null;
alter table public.creator_titles enable row level security; -- deny-all (service-role); Phase 6 adds SELECT policy

-- 2) creator_episodes — mirror of title_episodes, DRM/Mux-only in v1 (no embed).
create table public.creator_episodes (
  id               uuid primary key default gen_random_uuid(),
  creator_title_id uuid not null references public.creator_titles(id) on delete cascade,
  episode_number   integer not null,
  label            text,
  source           text not null default 'mux',
  mux_asset_id     text,
  mux_playback_id  text,
  requires_drm     boolean not null default true,
  is_published     boolean not null default false,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint creator_episodes_source_check check (source = 'mux'),
  constraint creator_episodes_mux_shape   check (mux_playback_id is not null), -- mirrors title_episodes mux shape
  constraint creator_episodes_unique      unique (creator_title_id, episode_number)
);
alter table public.creator_episodes enable row level security; -- deny-all (service-role)

-- 3) creator_mux_ingest_jobs — mirror of mux_ingest_jobs (same status CHECK, same
--    partial-unique backstop on mux_asset_id the webhook relies on for idempotency).
create table public.creator_mux_ingest_jobs (
  id                      uuid primary key default gen_random_uuid(),
  creator_title_id        uuid not null references public.creator_titles(id) on delete cascade,
  intended_episode_number integer,
  intended_label          text,
  mux_upload_id           text,
  mux_asset_id            text,
  mux_playback_id         text,
  requires_drm            boolean not null default true,
  status                  text not null default 'creating'
     check (status in ('creating','awaiting_upload','encoding','ready','errored')),
  error                   text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);
create index idx_creator_mux_jobs_upload
  on public.creator_mux_ingest_jobs (mux_upload_id) where mux_upload_id is not null;
create unique index uq_creator_mux_jobs_asset
  on public.creator_mux_ingest_jobs (mux_asset_id) where mux_asset_id is not null;
alter table public.creator_mux_ingest_jobs enable row level security; -- deny-all (service-role)

-- 4) mux_finalize_creator_asset_ready — exact mirror of mux_finalize_asset_ready,
--    keyed to the creator tables. Atomic + idempotent: locks the job, no-ops if
--    already ready, auto-numbers the episode, inserts the DRM creator_episode.
create or replace function public.mux_finalize_creator_asset_ready(
  p_job_id uuid, p_asset_id text, p_drm_playback_id text
) returns text
  language plpgsql
  security definer
  set search_path to 'public'
as $function$
declare
  v_job public.creator_mux_ingest_jobs%rowtype;
  v_episode_number integer;
begin
  select * into v_job
    from public.creator_mux_ingest_jobs
   where id = p_job_id
   for update;
  if not found then
    return 'job_not_found';
  end if;

  if v_job.status = 'ready' then
    return 'already_ready';
  end if;

  if v_job.intended_episode_number is not null then
    v_episode_number := v_job.intended_episode_number;
  else
    select coalesce(max(episode_number), 0) + 1
      into v_episode_number
      from public.creator_episodes
     where creator_title_id = v_job.creator_title_id;
  end if;

  insert into public.creator_episodes (
    creator_title_id, episode_number, label, source,
    mux_playback_id, mux_asset_id, requires_drm, is_published
  ) values (
    v_job.creator_title_id,
    v_episode_number,
    coalesce(v_job.intended_label, 'Episode ' || v_episode_number),
    'mux',
    p_drm_playback_id,
    p_asset_id,
    true,
    false
  );

  update public.creator_mux_ingest_jobs
     set status = 'ready',
         mux_playback_id = p_drm_playback_id
   where id = p_job_id;

  return 'inserted';
end;
$function$;
