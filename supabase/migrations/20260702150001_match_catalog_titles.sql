-- match_catalog_titles — trigram catalog matcher for the Source Accounts queue.
--
-- Reuses the EXACT proven approach of match_letterboxd_films (Phase 2B.1): the
-- GIN idx_titles_title_trgm index on lower(title) served via the `%` operator,
-- with a transaction-local pg_trgm.similarity_threshold and a similarity() >=
-- threshold recheck. Two differences, both required by the review queue:
--
--   (1) It RETURNS the similarity score (confidence) so the queue can store
--       source_account_posts.match_confidence. match_letterboxd_films only returns
--       matched_via ('exact'|'fuzzy'|'none'), not the number.
--   (2) year is OPTIONAL. Caption-extracted candidates carry a year when the post
--       uses the "Title (Director, Year)" form; when absent we match on title
--       similarity alone (still GIN-served). When present, we keep the year +/- 1
--       window for precision.
--
-- v1 matches lower(title) ONLY — NOT original_title (there is no trigram index on
-- original_title; a `%` probe there would seq-scan 1.4M rows). original_title
-- matching is a documented follow-up.
--
-- Threshold defaults to 0.6 — the same floor match_letterboxd_films uses. Service-
-- role only.

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
  -- pg_trgm GUC warm-load + transaction-local threshold. On a cold pooled backend
  -- the extension GUC isn't registered until first use; a throwaway similarity()
  -- forces _PG_init so the subsequent set_config is honored by the `%` operator.
  -- is_local => true keeps the tightened threshold off the shared pooled connection
  -- (reverts at txn end) and works at runtime for the non-superuser service_role
  -- owner (a per-function SET clause would fail 42501). See match_letterboxd_films.
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
  -- One best catalog row per input candidate. The `%` candidate set is GIN-served
  -- by idx_titles_title_trgm at the threshold set above; the explicit similarity
  -- recheck enforces the exact cutoff; year window (when provided) narrows it;
  -- best similarity then lowest id is the deterministic tie-break.
  best as (
    select i.i_idx, f.tid, f.sl, f.ti, f.yr, f.pub, f.conf
    from input i
    cross join lateral (
      select t.id as tid, t.slug as sl, t.title as ti, t.year as yr,
             t.is_public as pub,
             similarity(lower(t.title), lower(i.name)) as conf
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

-- Service-role only (the scrape/match route calls this through the service-role
-- client behind the admin auth gate). anon/authenticated must never reach it.
revoke all on function public.match_catalog_titles(jsonb, numeric) from public;
revoke all on function public.match_catalog_titles(jsonb, numeric) from anon, authenticated;
grant execute on function public.match_catalog_titles(jsonb, numeric) to service_role;
