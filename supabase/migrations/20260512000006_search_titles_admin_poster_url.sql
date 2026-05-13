-- Extend search_titles_admin to return poster_url so the Activate
-- Title modal can render thumbnails next to each result. Solves the
-- "5 identical 'Dina' entries with no visual disambiguation" problem
-- during partner activation workflow — year alone isn't enough when
-- multiple homonyms exist (especially common with TMDb seed data
-- that lacks release years on long-tail rows).
--
-- No other behavior change: WHERE/ORDER BY/LIMIT stay as set in
-- 20260512000004 (exact-match promotion). Adding poster_url to the
-- SELECT and the RETURNS TABLE; everything else is byte-identical.
--
-- DROP FUNCTION required: Postgres can't change a function's
-- RETURNS TABLE shape via CREATE OR REPLACE — column addition
-- counts as a row-type change (SQLSTATE 42P13).

drop function if exists public.search_titles_admin(text, integer);

create function public.search_titles_admin(
  query text,
  max_results integer default 20
)
returns table(
  id uuid,
  slug text,
  title text,
  year integer,
  poster_url text,
  partner_id uuid,
  is_active boolean,
  is_public boolean
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_pattern text := '%' || lower(query) || '%';
  v_exact text := lower(query);
begin
  return query
  select
    t.id,
    t.slug,
    t.title,
    t.year,
    t.poster_url,
    t.partner_id,
    t.is_active,
    t.is_public
  from public.titles t
  where lower(t.title) like v_pattern
    and t.deleted_at is null
  order by
    case when lower(t.title) = v_exact then 0 else 1 end,
    t.year desc nulls last,
    t.title asc
  limit greatest(1, least(max_results, 50));
end;
$$;

revoke execute on function public.search_titles_admin(text, integer) from public;
grant execute on function public.search_titles_admin(text, integer) to authenticated;
