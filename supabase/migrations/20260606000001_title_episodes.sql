-- Watch tab v1: title_episodes — an ordered list of a title's playable
-- episodes (free Instagram embeds for now). Additive: a single new
-- table, no ALTER to titles, reversible via DROP TABLE.
--
-- source/access are single-value CHECKs today, written DROP-then-ADD by
-- name (the media_type pattern) so a later 'mux'/'paid' is a one-line
-- constraint swap.
--
-- RLS is enabled with NO policies — service-role only, matching
-- getAllFilms/getSeriesTitles and the campaigns family. Reads go through
-- getTitleEpisodes (createServiceRoleClient); episode visibility rides on
-- the title page's own canViewTitle gate. No anon/authenticated access.

create table if not exists public.title_episodes (
  id uuid primary key default gen_random_uuid(),
  title_id uuid not null references public.titles(id) on delete cascade,
  episode_number integer not null,
  label text,
  embed_url text not null,
  source text not null default 'instagram',
  access text not null default 'free',
  cover_image_url text,
  is_published boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One row per (title, episode_number). The backing unique index also
  -- serves the Watch-tab read (WHERE title_id=$1 ORDER BY episode_number
  -- ASC), so a separate plain index on the same columns is intentionally
  -- omitted as redundant.
  constraint title_episodes_title_episode_unique unique (title_id, episode_number)
);

alter table public.title_episodes
  drop constraint if exists title_episodes_source_check;
alter table public.title_episodes
  add constraint title_episodes_source_check check (source in ('instagram'));

alter table public.title_episodes
  drop constraint if exists title_episodes_access_check;
alter table public.title_episodes
  add constraint title_episodes_access_check check (access in ('free'));

alter table public.title_episodes enable row level security;
-- No policies. Service-role only.

drop trigger if exists set_updated_at_title_episodes on public.title_episodes;
create trigger set_updated_at_title_episodes
  before update on public.title_episodes
  for each row execute function public.set_updated_at();
