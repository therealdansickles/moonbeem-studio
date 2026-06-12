-- Letterboxd import PUBLISH — Phase 2D.
--
-- Creator-scoped, all-or-nothing: flips this creator's private letterboxd
-- ratings/diary/lists to public, recomputes the affected title aggregates in one
-- set-based pass (per-row trigger suppressed via the 2A GUC), and MERGES the
-- imported watchlist (the lb://watchlist kind='list' container) into the
-- creator's native kind='watchlist' list, then drops the container. ONE
-- transaction (a single plpgsql call). Idempotent: a second call flips nothing
-- (no private letterboxd rows remain) and merges nothing (container gone).

create or replace function public.publish_letterboxd_import(p_creator_id uuid)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_ratings    int := 0;
  v_diary      int := 0;
  v_lists      int := 0;
  v_wl_merged  int := 0;
  v_wl_skipped int := 0;
  v_recomputed int := 0;
  v_title_ids  uuid[];
  v_container_id uuid;
  v_native_id  uuid;
  v_wl_base    int;
begin
  -- 1. Suppress the per-row rating-aggregate recompute for the whole flip; we do
  --    ONE set-based pass in step 3 instead (the 2A-designed bypass).
  perform set_config('app.skip_rating_agg', 'on', true);

  -- 2. Flip this creator's imported ratings public; collect the affected titles.
  with flipped as (
    update public.title_ratings
    set visibility = 'public'
    where creator_id = p_creator_id and source = 'letterboxd' and visibility = 'private'
    returning title_id
  )
  select array_agg(distinct title_id) filter (where title_id is not null),
         count(*)::int
  into v_title_ids, v_ratings
  from flipped;

  -- 3. Set-based recompute over the affected title_ids. Every one now has >= 1
  --    PUBLIC row (the rating we just flipped), so the aggregate subquery always
  --    returns a row — no empty-set reset path is needed here. The aggregate sums
  --    ALL public ratings on the title (every creator), matching the trigger.
  if v_title_ids is not null then
    update public.titles t
    set rating_avg = agg.avg_rating,
        rating_count = agg.cnt
    from (
      select tr.title_id,
             round(avg(tr.rating), 2) as avg_rating,
             count(*)::int as cnt
      from public.title_ratings tr
      where tr.title_id = any(v_title_ids) and tr.visibility = 'public'
      group by tr.title_id
    ) agg
    where t.id = agg.title_id;
    get diagnostics v_recomputed = row_count;
  end if;

  -- 4. Flip imported diary entries public.
  update public.diary_entries
  set visibility = 'public'
  where creator_id = p_creator_id and source = 'letterboxd' and visibility = 'private';
  get diagnostics v_diary = row_count;

  -- 5. Flip imported list containers public — EXCEPT the watchlist sentinel,
  --    which is merged into the native watchlist (step 6), not published as a list.
  update public.user_lists
  set visibility = 'public'
  where creator_id = p_creator_id and source = 'letterboxd' and visibility = 'private'
    and (external_uri is null or external_uri <> 'lb://watchlist');
  get diagnostics v_lists = row_count;

  -- 6. Watchlist merge: move the lb://watchlist container's items into the
  --    creator's native kind='watchlist' list, then delete the container.
  select id into v_container_id
  from public.user_lists
  where creator_id = p_creator_id and source = 'letterboxd' and external_uri = 'lb://watchlist';

  if v_container_id is not null then
    -- find-or-create the native watchlist (one-per-creator partial unique; a
    -- create race 23505s -> re-find). Mirrors lib/lists/server.findOrCreateWatchlist.
    select id into v_native_id
    from public.user_lists
    where creator_id = p_creator_id and kind = 'watchlist';
    if v_native_id is null then
      begin
        insert into public.user_lists (creator_id, name, kind, source, visibility)
        values (p_creator_id, 'Watchlist', 'watchlist', 'native', 'public')
        returning id into v_native_id;
      exception when unique_violation then
        select id into v_native_id
        from public.user_lists
        where creator_id = p_creator_id and kind = 'watchlist';
      end;
    end if;

    select coalesce(max(position), 0) into v_wl_base
    from public.user_list_items where list_id = v_native_id;

    -- Anti-join the container's items against the native list's existing
    -- (external_uri / non-null title_id); append survivors after the current max
    -- position in source order. Items keep source='letterboxd' (provenance;
    -- "native conversion on edit" happens later, on edit).
    insert into public.user_list_items
      (list_id, creator_id, title_id, tmdb_id, raw_title, raw_year, external_uri, position, source)
    with src as (
      select ci.title_id, ci.external_uri, ci.raw_title, ci.raw_year, ci.position
      from public.user_list_items ci
      where ci.list_id = v_container_id
    ),
    fresh as (
      select s.*
      from src s
      where not exists (
              select 1 from public.user_list_items e
              where e.list_id = v_native_id
                and s.external_uri is not null and e.external_uri = s.external_uri
            )
        and not exists (
              select 1 from public.user_list_items e
              where e.list_id = v_native_id
                and s.title_id is not null and e.title_id = s.title_id
            )
    )
    select v_native_id, p_creator_id, f.title_id, null, f.raw_title, f.raw_year, f.external_uri,
           v_wl_base + (row_number() over (order by f.position))::int,
           'letterboxd'
    from fresh f;
    get diagnostics v_wl_merged = row_count;

    v_wl_skipped := (select count(*) from public.user_list_items where list_id = v_container_id)
                    - v_wl_merged;

    -- Drop the container; its remaining (skipped) items go via FK cascade.
    delete from public.user_lists where id = v_container_id;
  end if;

  return jsonb_build_object(
    'ratings_published',  coalesce(v_ratings, 0),
    'diary_published',    v_diary,
    'lists_published',    v_lists,
    'watchlist_merged',   v_wl_merged,
    'watchlist_skipped',  v_wl_skipped,
    'titles_recomputed',  v_recomputed
  );
end;
$$;

-- Grants: service_role ONLY.
revoke all on function public.publish_letterboxd_import(uuid) from public;
revoke all on function public.publish_letterboxd_import(uuid) from anon, authenticated;
grant execute on function public.publish_letterboxd_import(uuid) to service_role;
