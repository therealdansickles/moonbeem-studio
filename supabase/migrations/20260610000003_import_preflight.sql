-- Letterboxd import pre-flight — Phase 2A.
--
-- Three inert-today changes that the Phase 2B/2C importer depends on. All run
-- against effectively-empty surfaces (0 external_uri rows, 0 imported rows),
-- so every index build is metadata-cheap and conflict-free:
--   (1) the (list_id, title_id) backstop the 1D app-level dedupe always wanted;
--   (2) re-scope the three film-level external_uri uniques from GLOBAL to
--       per-creator, because boxd.it film URIs are SHARED across users;
--   (3) add a GUC bypass to the rating-aggregate trigger so the 2C bulk-apply
--       can suppress the per-row recompute and do ONE set-based pass instead.
-- Pre-checked live (project qdngcwhubzomwymhaiel): 0 (list_id,title_id) dups;
-- 0 non-NULL external_uri rows on diary_entries / title_ratings / user_lists /
-- user_list_items.

-- (1) user_list_items (list_id, title_id) PARTIAL UNIQUE — the 1D backstop.
--     1D dup-prevention is app-level select-then-insert (lib/lists/server.ts
--     addItemToList); a concurrent/multi-tab/retried add can still create a
--     duplicate item. The reads were made dup-tolerant (.limit(1)); this is the
--     proper DB backstop. PARTIAL (title_id IS NOT NULL) so unmatched raw_title
--     rows — which legitimately repeat — are not constrained. DROP-then-create
--     idiom for a re-runnable migration.
drop index if exists public.user_list_items_list_title_unique;
create unique index user_list_items_list_title_unique
  on public.user_list_items (list_id, title_id)
  where title_id is not null;

-- (2) Re-scope the film-level external_uri dedupe uniques: GLOBAL -> per-creator.
--     RATIONALE: a Letterboxd boxd.it film URI is SHARED across users — the same
--     https://boxd.it/<id> appears in every importer's ratings.csv, watched.csv,
--     and list rows for that film. A GLOBAL unique on external_uri therefore
--     lets only the FIRST importer of a given film store that row and 23505s the
--     second importer. Scoping the dedupe to (creator_id, external_uri) keeps it
--     idempotent per creator (re-importing your own export updates in place)
--     while letting every creator import the same film.
--     user_list_items KEEPS its (list_id, external_uri) scoping — a list-row URI
--     is unique within a list, and list_id already implies the owning creator —
--     so it is deliberately left untouched.
drop index if exists public.diary_entries_external_uri_unique;
create unique index diary_entries_external_uri_unique
  on public.diary_entries (creator_id, external_uri)
  where external_uri is not null;

drop index if exists public.title_ratings_external_uri_unique;
create unique index title_ratings_external_uri_unique
  on public.title_ratings (creator_id, external_uri)
  where external_uri is not null;

drop index if exists public.user_lists_external_uri_unique;
create unique index user_lists_external_uri_unique
  on public.user_lists (creator_id, external_uri)
  where external_uri is not null;

-- (3) recompute_title_rating_agg: add a single GUC bypass at the top, otherwise
--     byte-identical to the live definition (CREATE OR REPLACE preserves the
--     trigger binding). The 2C bulk-apply RPC will `set local
--     app.skip_rating_agg = 'on'` around its bulk INSERT into title_ratings, so
--     this per-row AFTER trigger no-ops during the import, then the RPC runs ONE
--     set-based recompute over the touched title_ids. current_setting(...,true)
--     returns NULL (not an error) when the GUC is unset, so normal writes fall
--     straight through the guard. Nothing else in the body changed.
create or replace function public.recompute_title_rating_agg()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ids uuid[];
  v_id uuid;
begin
  -- 2A bypass: the 2C bulk-apply suppresses per-row recompute (set local) and
  -- does one set-based pass over the touched titles after the bulk insert.
  if current_setting('app.skip_rating_agg', true) = 'on' then
    return null;
  end if;

  select array_agg(distinct x) into v_ids
  from unnest(array[
    case when tg_op in ('INSERT','UPDATE') then NEW.title_id end,
    case when tg_op in ('DELETE','UPDATE') then OLD.title_id end
  ]) as x
  where x is not null;

  if v_ids is null then
    return null;
  end if;

  foreach v_id in array v_ids loop
    -- Lock the title row first so the aggregate runs on a post-lock snapshot
    -- (serializes concurrent recomputes of the same title).
    perform 1 from public.titles where id = v_id for update;

    update public.titles t
      set rating_avg = agg.avg_rating,
          rating_count = agg.cnt
      from (
        select
          round(avg(tr.rating), 2) as avg_rating,
          count(*)::int as cnt
        from public.title_ratings tr
        where tr.title_id = v_id
          and tr.visibility = 'public'
      ) agg
      where t.id = v_id;
  end loop;

  return null;
end;
$$;
