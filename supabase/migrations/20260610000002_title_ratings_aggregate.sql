-- Title ratings aggregate — Phase 1A.
--
-- Read-side companion to the title_ratings surface (20260610000001).
-- Denormalizes avg + count onto titles, trigger-maintained over PUBLIC
-- title_ratings rows only. The title page reads these via getTitleBySlug's
-- existing select("*") — no query change. There are 0 title_ratings rows
-- today (inert surface), so no backfill is needed; every title correctly
-- starts at rating_avg=NULL, rating_count=0.

-- (1) Columns.
--     Postgres >= 11 adds a column with a CONSTANT default WITHOUT a table
--     rewrite (metadata-only "fast default"), so rating_count is safe on the
--     ~1.4M-row titles table; rating_avg (NULL default) is likewise
--     metadata-only. No ACCESS EXCLUSIVE rewrite, no 1.4M-row scan.
alter table public.titles
  add column if not exists rating_avg numeric,
  add column if not exists rating_count integer not null default 0;

-- (2) Index serving the per-title recompute + public per-title reads.
--     title_ratings' unique leads on creator_id (creator_id, title_id), so a
--     WHERE title_id=$1 aggregate cannot use it; this partial index does, and
--     stays small (public rows only).
create index if not exists idx_title_ratings_title_public
  on public.title_ratings (title_id)
  where visibility = 'public';

-- (3) Trigger fn: recompute rating_avg + rating_count for the affected
--     title(s) from PUBLIC rows only. Handles INSERT/UPDATE/DELETE, a
--     title_id move (OLD vs NEW differ), a visibility flip, and NULL title_id
--     (skipped). SECURITY DEFINER so a write arriving under anon/owner RLS can
--     still update titles (titles has no UPDATE policy for end users).
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
  -- Distinct, non-null set of titles whose aggregate may have shifted.
  select array_agg(distinct x) into v_ids
  from unnest(array[
    case when tg_op in ('INSERT','UPDATE') then NEW.title_id end,
    case when tg_op in ('DELETE','UPDATE') then OLD.title_id end
  ]) as x
  where x is not null;

  if v_ids is null then
    return null;  -- only NULL title_id(s) involved → nothing to recompute
  end if;

  foreach v_id in array v_ids loop
    -- Serialize concurrent recomputes of the SAME title: take the title row
    -- lock first so the aggregate SELECT below runs on a post-lock snapshot.
    -- Without this, two creators rating one title concurrently can each see a
    -- stale count and last-writer-wins undercounts. One title at a time;
    -- different titles never contend.
    perform 1 from public.titles where id = v_id for update;

    -- Aggregates over an empty set return exactly one row (avg → NULL,
    -- count → 0), so this correctly resets a title to NULL/0 when its last
    -- public rating is deleted or flipped private. round(…,2) keeps the
    -- stored avg clean (display rounds to 1 decimal regardless).
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

  return null;  -- AFTER trigger; return value ignored.
end;
$$;

-- DROP-then-CREATE for partial-re-apply safety (matches house idiom).
drop trigger if exists trg_title_ratings_agg on public.title_ratings;
create trigger trg_title_ratings_agg
  after insert or update or delete on public.title_ratings
  for each row execute function public.recompute_title_rating_agg();

-- One-shot reconcile so the aggregate is correct regardless of apply order
-- (no-op on the current empty title_ratings surface; meaningful only if rows
-- already exist — e.g. a re-apply, or if a later phase lands ratings first).
-- Titles with no public ratings keep the column defaults (NULL / 0).
update public.titles t
  set rating_avg = agg.avg_rating,
      rating_count = agg.cnt
  from (
    select tr.title_id,
           round(avg(tr.rating), 2) as avg_rating,
           count(*)::int as cnt
    from public.title_ratings tr
    where tr.visibility = 'public' and tr.title_id is not null
    group by tr.title_id
  ) agg
  where t.id = agg.title_id;
