-- Extend titles table to absorb JustWatch + TMDb scraper output.
-- All new columns are nullable; scraper-imported titles default to is_active=false.
-- Curated rows (e.g. Erupcja) preserve their existing values via ON CONFLICT (slug) DO NOTHING in the uploader.

alter table public.titles
  add column if not exists jw_id text unique,
  add column if not exists tmdb_id bigint,
  add column if not exists imdb_id text,
  add column if not exists original_title text,
  add column if not exists tagline text,
  add column if not exists overview text,
  add column if not exists runtime_mins integer,
  add column if not exists genres text[],
  add column if not exists countries text[],
  add column if not exists keywords text[],
  add column if not exists cast_members jsonb,
  add column if not exists crew jsonb,
  add column if not exists trailers jsonb,
  add column if not exists poster_url_hd text,
  add column if not exists backdrop_url text,
  add column if not exists backdrop_url_hd text,
  add column if not exists images jsonb,
  add column if not exists availability jsonb,
  add column if not exists scores jsonb,
  add column if not exists vote_average numeric,
  add column if not exists popularity numeric,
  add column if not exists tmdb_matched boolean default false,
  add column if not exists scraped_at timestamptz,
  add column if not exists enriched_at timestamptz;

-- Index for slate selection search by title
create index if not exists idx_titles_search on public.titles using gin (to_tsvector('english', title));

-- Index for active titles (used by getTitleBySlug filter)
create index if not exists idx_titles_active_slug on public.titles (slug) where is_active = true;
