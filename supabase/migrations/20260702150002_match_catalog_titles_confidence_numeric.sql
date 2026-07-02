-- Fix: match_catalog_titles.confidence — similarity() returns `real`, but the
-- function's RETURNS TABLE declared `confidence numeric`, so RETURN QUERY raised
-- 42804 ("Returned type real does not match expected type numeric") on the first
-- call that produced a match. Cast the similarity to numeric at the source.
-- (match_letterboxd_films never hit this: it returns matched_via, not the score.)
-- source_account_posts.match_confidence is numeric, so numeric is the right target.

create or replace function public.match_catalog_titles(
  items jsonb,
  p_threshold numeric default 0.6
)
returns table (
  idx int,
  title_id uuid,
  slug text,
  title text,
  year int,
  is_public boolean,
  confidence numeric
)
language plpgsql
stable
set search_path = public
as $$
#variable_conflict use_column
begin
  perform similarity('x', 'x');
  perform set_config('pg_trgm.similarity_threshold', p_threshold::text, true);

  return query
  with input as (
    select
      (ord - 1)::int as i_idx,
      nullif(trim(elem->>'name'), '') as name,
      nullif(elem->>'year', '')::int as year
    from jsonb_array_elements(coalesce(items, '[]'::jsonb))
      with ordinality as t(elem, ord)
  ),
  best as (
    select i.i_idx, f.tid, f.sl, f.ti, f.yr, f.pub, f.conf
    from input i
    cross join lateral (
      select t.id as tid, t.slug as sl, t.title as ti, t.year as yr,
             t.is_public as pub,
             similarity(lower(t.title), lower(i.name))::numeric as conf
      from public.titles t
      where t.deleted_at is null
        and lower(t.title) % lower(i.name)
        and (i.year is null or t.year between i.year - 1 and i.year + 1)
        and similarity(lower(t.title), lower(i.name)) >= p_threshold
      order by similarity(lower(t.title), lower(i.name)) desc, t.id asc
      limit 1
    ) f
    where i.name is not null
  )
  select
    i.i_idx as idx,
    b.tid as title_id,
    b.sl as slug,
    b.ti as title,
    b.yr as year,
    b.pub as is_public,
    b.conf as confidence
  from input i
  left join best b on b.i_idx = i.i_idx
  order by i.i_idx;
end;
$$;

revoke all on function public.match_catalog_titles(jsonb, numeric) from public;
revoke all on function public.match_catalog_titles(jsonb, numeric) from anon, authenticated;
grant execute on function public.match_catalog_titles(jsonb, numeric) to service_role;
