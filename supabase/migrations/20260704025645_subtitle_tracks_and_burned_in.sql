-- Optional sidecar subtitle/caption tracks for Mux DRM episodes (Mux subtitle tracks
-- unit, 2026-07-04). A track attaches to a Mux ASSET, whose id lives on
-- title_episodes -> FK the episode. One episode -> many tracks (multi-language).
-- Nothing requires a row: absence = the silent no-CC case. Mirrors mux_ingest_jobs
-- RLS posture (service-role only, zero policies; every writer uses the service client
-- behind authorizeTitleMutation).
--
-- Applied to prod via apply_migration (recorded version 20260704025645); this file's
-- prefix is aligned to that version so `db push` will not re-run it.
create table public.subtitle_tracks (
  id               uuid primary key default gen_random_uuid(),
  title_episode_id uuid not null references public.title_episodes(id) on delete cascade,
  language_code    text not null,                  -- BCP-47, e.g. 'en', 'es'
  label            text,                            -- human name; Mux auto-fills from language_code if null
  mux_track_id     text,                            -- Track.id from createTrack; NULL until Mux accepts
  closed_captions  boolean not null default false,  -- SDH marker (accessibility), NOT a generic toggle
  status           text not null default 'pending'
    check (status in ('pending','preparing','ready','errored','deleted')),
  error            text,                            -- Mux error message, surfaced never-silent
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index subtitle_tracks_episode_idx on public.subtitle_tracks(title_episode_id);
create unique index subtitle_tracks_mux_track_id_key
  on public.subtitle_tracks(mux_track_id) where mux_track_id is not null;
alter table public.subtitle_tracks enable row level security;  -- no policies: service-role only

-- Burned-in marker: subs are baked into the video frames, so a sidecar CC track /
-- player CC menu would be redundant. Admin-visible so "no CC menu" is never ambiguous.
-- Title-level is correct for today's 1-asset films; GRADUATION PATH: move to
-- title_episodes.subtitles_burned_in if multi-asset films ever appear.
alter table public.titles
  add column subtitles_burned_in boolean not null default false;
