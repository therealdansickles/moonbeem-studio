-- Public search_titles RPC: promote exact title matches + exclude soft-deleted.
--
-- Mirrors the exact-match fix shipped to search_titles_admin in
-- 20260512000004. The public RPC has a different rank formula
-- (featured/active/prefix/substring/popularity weighted bonuses) so
-- the exact-match contribution must dominate the existing max:
--   featured(100) + active(50) + prefix(30) + substring(10) +
--   popularity/100 (≤ 1 in practice) ≈ 191 ceiling
-- A 200-point exact-match bonus guarantees exact title matches
-- always lead regardless of activation state or popularity.
--
-- Also adds AND t.deleted_at IS NULL — the original RPC body
-- omitted this filter, so soft-deleted titles could surface in
-- public search if their text matched. The admin RPC already
-- excludes soft-deleted; aligning behavior.
--
-- Inactive titles remain queryable on purpose. Search reflects
-- "what Moonbeem knows about," activation state affects ranking
-- (the +50 active bonus) and the title page UX, not search
-- visibility.

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
      case when lower(t.title) = lower(query) then 200.0 else 0.0 end
      + case when t.is_featured then 100.0 else 0.0 end
      + case when t.is_active then 50.0 else 0.0 end
      + case when lower(t.title) like lower(query) || '%' then 30.0 else 0.0 end
      + case when lower(t.title) like '%' || lower(query) || '%' then 10.0 else 0.0 end
      + coalesce(t.popularity, 0)::float / 100.0
    )::float as rank
  from public.titles t
  where lower(t.title) like '%' || lower(query) || '%'
    and t.deleted_at is null
  order by rank desc, t.title asc
  limit max_results;
end;
$$ language plpgsql stable;

grant execute on function public.search_titles(text, int) to anon, authenticated;
