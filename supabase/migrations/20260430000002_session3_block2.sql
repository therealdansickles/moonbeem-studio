-- Session 3 / Block 2: profile fields, trigram index, search_titles RPC.

alter table public.users
  add column if not exists handle text unique,
  add column if not exists display_name text,
  add column if not exists bio text,
  add column if not exists avatar_url text,
  add column if not exists links jsonb default '[]'::jsonb;

create index if not exists idx_users_handle
  on public.users(handle)
  where handle is not null;

-- Trigram extension powers fast %query% lookups on title text.
-- A to_tsvector index already exists from the catalog migration (idx_titles_search);
-- we skip recreating it here. The trigram index below accelerates the
-- LIKE-based ranking used in search_titles.
create extension if not exists pg_trgm;

create index if not exists idx_titles_title_trgm
  on public.titles using gin (lower(title) gin_trgm_ops);

create or replace function public.search_titles(query text, max_results int default 8)
returns table (
  id uuid,
  slug text,
  title text,
  poster_url text,
  year integer,
  distributor text,
  is_active boolean,
  is_featured boolean,
  rank float
) as $$
begin
  return query
  select
    t.id,
    t.slug,
    t.title,
    t.poster_url,
    t.year,
    t.distributor,
    t.is_active,
    t.is_featured,
    (
      case when t.is_featured then 100.0 else 0.0 end
      + case when t.is_active then 50.0 else 0.0 end
      + case when lower(t.title) like lower(query) || '%' then 30.0 else 0.0 end
      + case when lower(t.title) like '%' || lower(query) || '%' then 10.0 else 0.0 end
      + coalesce(t.popularity, 0)::float / 100.0
    )::float as rank
  from public.titles t
  where lower(t.title) like '%' || lower(query) || '%'
  order by rank desc, t.title asc
  limit max_results;
end;
$$ language plpgsql stable;

grant execute on function public.search_titles(text, int) to anon, authenticated;
