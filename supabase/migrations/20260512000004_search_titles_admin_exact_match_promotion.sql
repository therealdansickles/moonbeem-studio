-- Promote exact title matches in search_titles_admin.
--
-- Before: ORDER BY year DESC, title ASC. With ~1.4M rows and a heavy
-- skew toward year=2026 (TMDb's upcoming/unreleased fill), substring
-- matches from recent years saturate the first 50 rows. Searching
-- "RAD" returned Mr. Paradise, 18 Holes to Paradise, Cradle & Step,
-- etc. — but never RAD (1986, TMDb ID 13841), which is buried past
-- the hard LIMIT 50.
--
-- After: add a CASE expression as the leading ORDER BY key so any
-- exact case-insensitive title match floats to the top regardless of
-- year. Non-exact matches keep their year-DESC ordering, so the
-- "browse recent films matching X" behavior is preserved.
--
-- Index alignment unchanged: the trigram GIN on lower(title) still
-- accelerates the LIKE predicate. The CASE in ORDER BY adds a tiny
-- per-row sort cost after the trigram filter narrows the candidate
-- set; negligible against the indexed scan win.

create or replace function public.search_titles_admin(
  query text,
  max_results integer default 20
)
returns table(
  id uuid,
  slug text,
  title text,
  year integer,
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
