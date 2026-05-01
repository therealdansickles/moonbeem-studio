-- Fix the unique constraint introduced in 20260501000005: TMDb ID namespaces
-- are distinct between movies and TV (movie 100 ≠ TV 100). The unique key
-- must include media_type or legitimate TV inserts will collide with
-- existing movies that happen to share a numeric ID.

drop index if exists public.idx_titles_tmdb_id_unique;

create unique index if not exists idx_titles_tmdb_id_media_unique
  on public.titles(tmdb_id, media_type)
  where tmdb_id is not null;
