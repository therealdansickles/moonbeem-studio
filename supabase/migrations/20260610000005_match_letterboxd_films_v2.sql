-- Letterboxd import matching — Phase 2B.1 (matcher timeout fix, full-catalog scope).
--
-- Supersedes the 2B matcher. Two findings from the 2B.1 recon drove this:
--
-- (1) FULL-CATALOG MATCH (ruling 2B.1). The 2B matcher filtered is_public inside
--     the query. But titles is 1.43M rows of which only ~20 are public, and there
--     is NO index on the is_public predicate — so resolving the public set forced a
--     ~25s full seq scan of the 3.5 GB heap, ~8x over the ~8s service_role/PostgREST
--     statement_timeout (the 2B import job failed exactly here: "canceling statement
--     due to statement timeout"). We now match against the WHOLE catalog: imports
--     attach to staged titles, and visibility is enforced at render time by the
--     existing read-side filters. We exclude only DELETED rows, as a cheap post-
--     filter on the handful of index candidates per ref. The RPC now RETURNS
--     is_public so the preview can label live vs catalog-only matches.
--
-- (2) NO OR-JOIN IN TIER 1. A single `lower(title)=name OR lower(original_title)=name`
--     predicate cannot use either btree (the OR defeats index selection) and again
--     seq-scans 1.43M (recon: tier-1 OR-join alone > 25s). Splitting it into a UNION
--     of two equality-only probes lets EACH btree serve its own branch
--     (idx_titles_lower_title_year and the new idx_titles_lower_orig_title_year) as
--     index nested loops — milliseconds per ref.

-- (a) Original-title exact-tier index — the mirror of idx_titles_lower_title_year so
--     tier 1's original_title branch is index-served too. Build cost: an expression
--     btree over 1.43M rows, ~tens of seconds (comparable to the ~75s lower(title)
--     build) — INDEX-ONLY, no table rewrite, existing rows untouched. A plain
--     (non-CONCURRENT) CREATE INDEX is required inside apply_migration's transaction;
--     it takes a brief SHARE lock on the read-mostly titles catalog at deploy.
--     Partial on original_title IS NOT NULL (rows without it can never match here).
create index if not exists idx_titles_lower_orig_title_year
  on public.titles (lower(original_title), year)
  where original_title is not null;

-- (b) match_letterboxd_films(items jsonb).
--     The return shape GAINS is_public, which is a RETURNS TABLE change: a bare
--     CREATE OR REPLACE raises 42P13 ("cannot change return type of existing
--     function"), so we DROP first. The drop+create is atomic inside the migration
--     transaction (no callable gap), and the grant block is re-asserted below.
drop function if exists public.match_letterboxd_films(jsonb);

create function public.match_letterboxd_films(items jsonb)
returns table (idx int, title_id uuid, tmdb_id bigint, slug text, is_public boolean, matched_via text)
language plpgsql
stable
set search_path = public
as $$
#variable_conflict use_column
begin
  -- Threshold setup, in THIS order, per two runtime caveats proven in the recon:
  --   1. Warm-load pg_trgm FIRST. On a cold pooled backend the module isn't loaded;
  --      SET-ting pg_trgm.similarity_threshold before first use lands on an
  --      unrecognized placeholder the % operator does NOT honor — it then scans at
  --      the 0.3 default (~20.8k trigram candidates per probe, ~1.7s each: the fuzzy
  --      bloat). A throwaway similarity() call forces the extension's _PG_init to
  --      register the GUC. (Measured: 0.3 -> 20,785 candidates / 1,705 ms;
  --      0.6 -> 953 / 30.6 ms for one probe.)
  --   2. set_config(..., is_local => true) is TRANSACTION-LOCAL: pooling-safe (it
  --      reverts at txn end, so 0.6 never leaks onto the shared connection where
  --      search and other trgm consumers expect the 0.3 default), AND it works at
  --      runtime for the non-superuser service_role. A per-function
  --      `SET pg_trgm.similarity_threshold = 0.6` clause cannot be used: it is
  --      validated at CREATE time against the (then-unloaded) extension placeholder
  --      and fails with 42501 "permission denied to set parameter" under the
  --      non-superuser owner.
  perform similarity('x', 'x');
  perform set_config('pg_trgm.similarity_threshold', '0.6', true);

  return query
  with input as (
    select
      (ord - 1)::int as i_idx,
      nullif(trim(elem->>'name'), '') as name,
      nullif(elem->>'year', '')::int as year
    from jsonb_array_elements(coalesce(items, '[]'::jsonb)) with ordinality as t(elem, ord)
  ),
  -- Tier 1 (exact): UNION of two equality-only probes so each btree serves its own
  -- branch. deleted_at IS NULL is a cheap post-filter on the few index hits per ref.
  -- is_public is CARRIED THROUGH (not filtered) for the preview's live/catalog split.
  exact_match as (
    -- title branch -> idx_titles_lower_title_year (lower(title), year)
    select i.i_idx, t.id as tid, t.tmdb_id as tmdb, t.slug as sl, t.is_public as pub
    from input i
    join public.titles t
      on t.year = i.year
     and lower(t.title) = lower(i.name)
    where i.name is not null and i.year is not null
      and t.deleted_at is null
    union all
    -- original_title branch -> idx_titles_lower_orig_title_year (lower(original_title), year)
    select i.i_idx, t.id, t.tmdb_id, t.slug, t.is_public
    from input i
    join public.titles t
      on t.year = i.year
     and t.original_title is not null
     and lower(t.original_title) = lower(i.name)
    where i.name is not null and i.year is not null
      and t.deleted_at is null
  ),
  -- Dedupe to one row per input item; tie-break lowest id (unchanged from 2B).
  exact_best as (
    select i_idx, tid, tmdb, sl, pub
    from (
      select i_idx, tid, tmdb, sl, pub,
             row_number() over (partition by i_idx order by tid) as rn
      from exact_match
    ) r
    where rn = 1
  ),
  -- Tier 2 (fuzzy) runs ONLY for tier-1 misses.
  misses as (
    select i.i_idx, i.name, i.year
    from input i
    where i.name is not null and i.year is not null
      and not exists (select 1 from exact_best e where e.i_idx = i.i_idx)
  ),
  -- Lateral: one best row per miss. % candidate (GIN idx_titles_title_trgm at the
  -- 0.6 threshold set above) AND an explicit similarity >= 0.6 recheck; year within
  -- +/-1; deleted_at IS NULL; best similarity then lowest id (tie-break unchanged).
  fuzzy_best as (
    select m.i_idx, f.tid, f.tmdb, f.sl, f.pub
    from misses m
    cross join lateral (
      select t.id as tid, t.tmdb_id as tmdb, t.slug as sl, t.is_public as pub
      from public.titles t
      where t.deleted_at is null
        and t.year between m.year - 1 and m.year + 1
        and lower(t.title) % lower(m.name)
        and similarity(lower(t.title), lower(m.name)) >= 0.6
      order by similarity(lower(t.title), lower(m.name)) desc, t.id asc
      limit 1
    ) f
  )
  select
    i.i_idx as idx,
    coalesce(e.tid, f.tid) as title_id,
    coalesce(e.tmdb, f.tmdb) as tmdb_id,
    coalesce(e.sl, f.sl) as slug,
    coalesce(e.pub, f.pub) as is_public,
    case
      when e.tid is not null then 'exact'
      when f.tid is not null then 'fuzzy'
      else 'none'
    end as matched_via
  from input i
  left join exact_best e on e.i_idx = i.i_idx
  left join fuzzy_best f on f.i_idx = i.i_idx
  order by i.i_idx;
end;
$$;

-- (c) Grants: service_role ONLY (re-asserted after the drop+create). The preview/
--     apply routes call this through the service-role client; anon/authenticated
--     must never reach the matcher.
revoke all on function public.match_letterboxd_films(jsonb) from public;
revoke all on function public.match_letterboxd_films(jsonb) from anon, authenticated;
grant execute on function public.match_letterboxd_films(jsonb) to service_role;
