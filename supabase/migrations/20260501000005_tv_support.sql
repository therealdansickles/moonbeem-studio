-- Session 4 / Tier 2 / overnight scrape prep:
-- Extend titles to cover both movies and TV via media_type, plus TV-specific
-- columns. Adds a partial unique index on tmdb_id (only when not null) so
-- discovery upserts can use ON CONFLICT (tmdb_id) DO NOTHING. enriched_at
-- already exists from the scraper extension migration; we just add an index
-- to make resumability scans cheap.

alter table public.titles
  add column if not exists media_type text not null default 'movie',
  add column if not exists first_air_date date,
  add column if not exists last_air_date date,
  add column if not exists number_of_seasons integer,
  add column if not exists number_of_episodes integer,
  add column if not exists networks jsonb,
  add column if not exists production_companies jsonb,
  add column if not exists release_date date,
  add column if not exists deleted boolean not null default false;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'titles_media_type_check'
  ) then
    alter table public.titles
      add constraint titles_media_type_check
      check (media_type in ('movie', 'tv'));
  end if;
end$$;

-- Partial unique index on tmdb_id where not null. Lets discovery upserts
-- target ON CONFLICT (tmdb_id) safely without breaking hand-seeded rows
-- that have tmdb_id null.
create unique index if not exists idx_titles_tmdb_id_unique
  on public.titles(tmdb_id)
  where tmdb_id is not null;

-- Resumability: enrichment scans WHERE enriched_at IS NULL repeatedly.
-- Partial index keeps it cheap as the un-enriched set shrinks.
create index if not exists idx_titles_media_type_enriched
  on public.titles(media_type, enriched_at)
  where enriched_at is null;
