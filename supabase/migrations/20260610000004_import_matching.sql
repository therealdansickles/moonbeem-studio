-- Letterboxd import matching — Phase 2B.
--
-- The matcher the import preview calls: given Letterboxd film references
-- {name, year} (Letterboxd CSVs carry NO TMDb id — confirmed on the real
-- export), resolve each to a public titles row via a two-tier strategy
-- (exact name+year, then trigram fuzzy within +/-1 year). Read-only; writes
-- nothing. The preview/apply flow lives in the routes.

-- (1) Exact-tier supporting index: btree on (lower(title), year).
--     COST: titles is ~1.43M rows. This is an INDEX-ONLY build — no table
--     rewrite, no column change, so existing rows are untouched (the heap is
--     read once to build the btree, ~tens of seconds). A plain (non-CONCURRENT)
--     CREATE INDEX takes a SHARE lock that blocks WRITES to titles for the
--     build duration; titles is a read-mostly catalog written only by the
--     catalog-sync jobs, so a brief one-off write pause at deploy is acceptable
--     (and far cheaper than the alternative: every exact lookup seq-scanning
--     1.43M rows). Serves `lower(title) = lower($name) AND year = $year`.
create index if not exists idx_titles_lower_title_year
  on public.titles (lower(title), year);

-- (2) match_letterboxd_films(items jsonb) -> one row per input item.
--     items = [{name, year}, ...]; idx is the 0-based input position.
--     Tier 1 (exact): lower(title) OR lower(original_title) = lower(name) AND
--       year = year. The title branch is index-served (idx_titles_lower_title_year);
--       the original_title branch hash-joins a single titles scan (no second
--       index by design — one set-based pass, seconds at import scale).
--     Tier 2 (fuzzy): only for items the exact tier missed — trigram
--       similarity(lower(title), lower(name)) >= 0.6 AND year BETWEEN year-1
--       AND year+1, best-similarity-wins. The `%` operator (GIN-served by
--       idx_titles_title_trgm, built on lower(title)) generates candidates at
--       the ambient threshold (0.3 — a strict superset of 0.6); an explicit
--       `similarity(...) >= 0.6` recheck enforces the exact cutoff. We do NOT
--       set pg_trgm.similarity_threshold at the function level: pg_trgm is an
--       unloaded-extension placeholder when the SET is validated at CREATE and
--       re-applied at runtime, and setting it there raises 42501 for the
--       non-superuser role that owns and calls this function.
--     Ties broken deterministically: highest similarity, then lowest id.
--     Only is_public = true AND deleted_at IS NULL titles are eligible.
--     Returns matched_via = 'exact' | 'fuzzy' | 'none' for EVERY item so the
--     caller can map results back by idx.
create or replace function public.match_letterboxd_films(items jsonb)
returns table (idx int, title_id uuid, tmdb_id bigint, slug text, matched_via text)
language sql
stable
set search_path = public
as $$
  with input as (
    select
      (ord - 1)::int as i_idx,
      nullif(trim(elem->>'name'), '') as name,
      nullif(elem->>'year', '')::int as year
    from jsonb_array_elements(coalesce(items, '[]'::jsonb)) with ordinality as t(elem, ord)
  ),
  exact_match as (
    -- title branch (index nested loop on idx_titles_lower_title_year)
    select i.i_idx, t.id as tid, t.tmdb_id as tmdb, t.slug as slug
    from input i
    join public.titles t
      on t.is_public = true and t.deleted_at is null
     and i.name is not null and i.year is not null
     and t.year = i.year
     and lower(t.title) = lower(i.name)
    union all
    -- original_title branch (single hash join scan)
    select i.i_idx, t.id, t.tmdb_id, t.slug
    from input i
    join public.titles t
      on t.is_public = true and t.deleted_at is null
     and i.name is not null and i.year is not null
     and t.year = i.year
     and t.original_title is not null
     and lower(t.original_title) = lower(i.name)
  ),
  exact_best as (
    select i_idx, tid, tmdb, slug
    from (
      select i_idx, tid, tmdb, slug,
             row_number() over (partition by i_idx order by tid) as rn
      from exact_match
    ) r
    where rn = 1
  ),
  fuzzy_best as (
    select i_idx, tid, tmdb, slug
    from (
      select i.i_idx, t.id as tid, t.tmdb_id as tmdb, t.slug as slug,
             row_number() over (
               partition by i.i_idx
               order by similarity(lower(t.title), lower(i.name)) desc, t.id asc
             ) as rn
      from input i
      join public.titles t
        on t.is_public = true and t.deleted_at is null
       and i.name is not null and i.year is not null
       and t.year between i.year - 1 and i.year + 1
       and lower(t.title) % lower(i.name)
       and similarity(lower(t.title), lower(i.name)) >= 0.6
      where not exists (select 1 from exact_best e where e.i_idx = i.i_idx)
    ) r
    where rn = 1
  )
  select
    i.i_idx as idx,
    coalesce(e.tid, f.tid) as title_id,
    coalesce(e.tmdb, f.tmdb) as tmdb_id,
    coalesce(e.slug, f.slug) as slug,
    case
      when e.tid is not null then 'exact'
      when f.tid is not null then 'fuzzy'
      else 'none'
    end as matched_via
  from input i
  left join exact_best e on e.i_idx = i.i_idx
  left join fuzzy_best f on f.i_idx = i.i_idx
  order by i.i_idx;
$$;

-- (3) Grants: service_role ONLY. The preview/apply routes call this through the
--     service-role client; anon/authenticated must never reach the matcher.
revoke all on function public.match_letterboxd_films(jsonb) from public;
revoke all on function public.match_letterboxd_films(jsonb) from anon, authenticated;
grant execute on function public.match_letterboxd_films(jsonb) to service_role;
