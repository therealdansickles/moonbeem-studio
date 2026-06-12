-- Letterboxd WATCHED — Phase 2E.1.
--
-- "Watched" is a FLAG, not an event: a film the creator has marked watched on
-- Letterboxd. It is its OWN table (never a diary row) and carries no rating /
-- rewatch / review. marked_on stores the watched.csv "Date" honestly — it is a
-- marked-on date, not a watch date, and is not displayed in v1.
--
-- Mirrors the Phase 0 diary_entries idiom (columns, set_updated_at trigger, RLS).
-- Uniques are BOTH plain partial and NON-deferrable, which keeps a no-target
-- ON CONFLICT DO NOTHING legal on this table (the 2C.1 lesson: a deferrable
-- unique poisons no-target arbiter inference).
--
-- This migration also CREATE-OR-REPLACEs the apply + publish RPCs to add the
-- watched step (apply: bulk insert private/letterboxd; publish: flip to public).

-- ############################################################################
-- 1. Table
-- ############################################################################
create table if not exists public.watched_titles (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.creators(id) on delete cascade,
  title_id uuid references public.titles(id) on delete set null,
  tmdb_id bigint,
  raw_title text,
  raw_year int,
  external_uri text,
  marked_on date not null,
  source text not null check (source in ('native','letterboxd')),
  visibility text not null default 'private' check (visibility in ('private','public')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Dedupe keys: the film URI (the watched.csv "Letterboxd URI") and the matched
-- title. BOTH plain partial, NON-deferrable.
create unique index if not exists watched_titles_external_uri_unique
  on public.watched_titles (creator_id, external_uri) where external_uri is not null;
create unique index if not exists watched_titles_creator_title_unique
  on public.watched_titles (creator_id, title_id) where title_id is not null;
create index if not exists idx_watched_titles_creator on public.watched_titles (creator_id);
create index if not exists idx_watched_titles_title on public.watched_titles (title_id) where title_id is not null;

drop trigger if exists trg_watched_titles_updated_at on public.watched_titles;
create trigger trg_watched_titles_updated_at
  before update on public.watched_titles
  for each row execute function public.set_updated_at();

-- ############################################################################
-- 2. RLS — owner-all through creators (auth.uid()), public read of public rows.
--    Mirrors the diary_entries policies verbatim.
-- ############################################################################
alter table public.watched_titles enable row level security;
drop policy if exists "watched_titles owner all" on public.watched_titles;
create policy "watched_titles owner all"
  on public.watched_titles for all
  using (exists (select 1 from public.creators c
                 where c.id = watched_titles.creator_id and c.user_id = auth.uid()))
  with check (exists (select 1 from public.creators c
                 where c.id = watched_titles.creator_id and c.user_id = auth.uid()));
drop policy if exists "watched_titles public read" on public.watched_titles;
create policy "watched_titles public read"
  on public.watched_titles for select
  using (visibility = 'public');

-- ############################################################################
-- 3. apply_letterboxd_import — add the WATCHED step (4b). Same signature, same
--    return shape + a 'watched' counts object. Legacy payloads lack the
--    'watched' key; coalesce('[]') so they never raise. Steps 1-7 are otherwise
--    byte-identical to 20260610000007 (v2).
-- ############################################################################
create or replace function public.apply_letterboxd_import(p_job_id uuid)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_creator_id uuid;
  v_status     text;
  v_payload    jsonb;
  v_r_att int;  v_r_ins int;
  v_d_att int;  v_d_ins int;
  v_w_att int;  v_w_ins int;
  v_c_att int;  v_c_ins int;
  v_li_att int := 0;  v_li_ins int := 0;
  v_n int;
  v_list_id uuid;
  v_base int;
  v_container jsonb;
  v_applied jsonb;
begin
  -- 1. Lock the job; require it is mid-apply with a pinned payload + creator.
  select creator_id, status, payload
    into v_creator_id, v_status, v_payload
  from public.letterboxd_import_jobs
  where id = p_job_id
  for update;
  if not found then
    raise exception 'apply_letterboxd_import: job % not found', p_job_id;
  end if;
  if v_status <> 'applying' then
    raise exception 'apply_letterboxd_import: job % is % not applying', p_job_id, v_status;
  end if;
  if v_payload is null then
    raise exception 'apply_letterboxd_import: job % has no pinned payload (re-upload required)', p_job_id;
  end if;
  if v_creator_id is null then
    raise exception 'apply_letterboxd_import: job % has no creator_id', p_job_id;
  end if;

  -- 2. Suppress the per-row rating-aggregate recompute for the whole txn.
  perform set_config('app.skip_rating_agg', 'on', true);

  -- 3. Ratings. (unchanged)
  v_r_att := jsonb_array_length(coalesce(v_payload->'ratings', '[]'::jsonb));
  insert into public.title_ratings
    (creator_id, title_id, tmdb_id, raw_title, raw_year, external_uri, rating, rated_on, source, visibility)
  select v_creator_id, r.title_id, null, r.raw_title, r.raw_year, r.external_uri, r.rating, r.rated_on,
         'letterboxd', 'private'
  from jsonb_to_recordset(coalesce(v_payload->'ratings', '[]'::jsonb))
       as r(title_id uuid, rating numeric, rated_on date, external_uri text, raw_title text, raw_year int)
  where r.rating is not null
  on conflict do nothing;
  get diagnostics v_r_ins = row_count;

  -- 4. Diary + reviews. (unchanged)
  v_d_att := jsonb_array_length(coalesce(v_payload->'diary', '[]'::jsonb));
  insert into public.diary_entries
    (creator_id, title_id, tmdb_id, raw_title, raw_year, external_uri, watched_on, rewatch,
     rating, review_text, contains_spoilers, source, visibility)
  select v_creator_id, d.title_id, null, d.raw_title, d.raw_year, d.external_uri, d.watched_on,
         coalesce(d.rewatch, false), d.rating, d.review_text, coalesce(d.contains_spoilers, false),
         'letterboxd', 'private'
  from jsonb_to_recordset(coalesce(v_payload->'diary', '[]'::jsonb))
       as d(title_id uuid, rating numeric, watched_on date, review_text text,
             contains_spoilers boolean, rewatch boolean, external_uri text, raw_title text, raw_year int)
  where d.watched_on is not null
  on conflict do nothing;
  get diagnostics v_d_ins = row_count;

  -- 4b. Watched (NEW in 2E.1). Marked-watched flags; no rating/rewatch/review.
  --     marked_on is NOT NULL — drop null-marked rows (defensive; the payload
  --     already filters them). No-target ON CONFLICT DO NOTHING is legal: the
  --     two partial uniques are non-deferrable. Legacy payloads (pre-2E.1) have
  --     no 'watched' key -> coalesce('[]') -> 0 rows, never raises.
  v_w_att := jsonb_array_length(coalesce(v_payload->'watched', '[]'::jsonb));
  insert into public.watched_titles
    (creator_id, title_id, tmdb_id, raw_title, raw_year, external_uri, marked_on, source, visibility)
  select v_creator_id, w.title_id, null, w.raw_title, w.raw_year, w.external_uri, w.marked_on,
         'letterboxd', 'private'
  from jsonb_to_recordset(coalesce(v_payload->'watched', '[]'::jsonb))
       as w(title_id uuid, marked_on date, external_uri text, raw_title text, raw_year int)
  where w.marked_on is not null
  on conflict do nothing;
  get diagnostics v_w_ins = row_count;

  -- 5. Containers. (unchanged)
  v_c_att := jsonb_array_length(coalesce(v_payload->'containers', '[]'::jsonb));
  insert into public.user_lists (creator_id, name, kind, external_uri, source, visibility)
  select v_creator_id, c.name, 'list', c.external_uri, 'letterboxd', 'private'
  from jsonb_to_recordset(coalesce(v_payload->'containers', '[]'::jsonb))
       as c(name text, external_uri text)
  on conflict (creator_id, external_uri) where external_uri is not null do nothing;
  get diagnostics v_c_ins = row_count;

  -- 6. Items per container — NO ON CONFLICT (hand-rolled idempotency). (unchanged)
  for v_container in
    select * from jsonb_array_elements(coalesce(v_payload->'containers', '[]'::jsonb))
  loop
    select id into v_list_id
    from public.user_lists
    where creator_id = v_creator_id and external_uri = (v_container->>'external_uri');

    select coalesce(max(position), 0) into v_base
    from public.user_list_items
    where list_id = v_list_id;

    v_li_att := v_li_att + jsonb_array_length(coalesce(v_container->'items', '[]'::jsonb));

    insert into public.user_list_items
      (list_id, creator_id, title_id, tmdb_id, raw_title, raw_year, external_uri, position, source)
    with raw_items as (
      select it.title_id, it.external_uri, it.raw_title, it.raw_year, it.position
      from jsonb_to_recordset(coalesce(v_container->'items', '[]'::jsonb))
           as it(title_id uuid, external_uri text, raw_title text, raw_year int, position int)
    ),
    ranked as (
      select ri.*,
             row_number() over (partition by ri.external_uri order by ri.position) as rn_uri,
             row_number() over (partition by ri.title_id     order by ri.position) as rn_tid
      from raw_items ri
    ),
    deduped as (
      select * from ranked
      where (external_uri is null or rn_uri = 1)
        and (title_id is null or rn_tid = 1)
    ),
    fresh as (
      select d.*
      from deduped d
      where not exists (
              select 1 from public.user_list_items e
              where e.list_id = v_list_id
                and d.external_uri is not null and e.external_uri = d.external_uri
            )
        and not exists (
              select 1 from public.user_list_items e
              where e.list_id = v_list_id
                and d.title_id is not null and e.title_id = d.title_id
            )
    )
    select v_list_id, v_creator_id, f.title_id, null, f.raw_title, f.raw_year, f.external_uri,
           v_base + (row_number() over (order by f.position))::int,
           'letterboxd'
    from fresh f;
    get diagnostics v_n = row_count;
    v_li_ins := v_li_ins + v_n;
  end loop;

  -- 7. Applied counts + complete. Adds the 'watched' object.
  v_applied := jsonb_build_object(
    'ratings',    jsonb_build_object('attempted', v_r_att,  'inserted', v_r_ins,  'skipped', v_r_att  - v_r_ins),
    'diary',      jsonb_build_object('attempted', v_d_att,  'inserted', v_d_ins,  'skipped', v_d_att  - v_d_ins),
    'watched',    jsonb_build_object('attempted', v_w_att,  'inserted', v_w_ins,  'skipped', v_w_att  - v_w_ins),
    'lists',      jsonb_build_object('attempted', v_c_att,  'inserted', v_c_ins,  'skipped', v_c_att  - v_c_ins),
    'list_items', jsonb_build_object('attempted', v_li_att, 'inserted', v_li_ins, 'skipped', v_li_att - v_li_ins)
  );

  update public.letterboxd_import_jobs
  set counts = v_applied, status = 'completed'
  where id = p_job_id and status = 'applying';

  return v_applied;
end;
$$;

revoke all on function public.apply_letterboxd_import(uuid) from public;
revoke all on function public.apply_letterboxd_import(uuid) from anon, authenticated;
grant execute on function public.apply_letterboxd_import(uuid) to service_role;

-- ############################################################################
-- 4. publish_letterboxd_import — add the WATCHED flip (4b). No aggregate work
--    (watched_titles has no rating trigger / recompute). Same signature; return
--    jsonb gains 'watched_published'. Steps otherwise identical to 20260610000008.
-- ############################################################################
create or replace function public.publish_letterboxd_import(p_creator_id uuid)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_ratings    int := 0;
  v_diary      int := 0;
  v_watched    int := 0;
  v_lists      int := 0;
  v_wl_merged  int := 0;
  v_wl_skipped int := 0;
  v_recomputed int := 0;
  v_title_ids  uuid[];
  v_container_id uuid;
  v_native_id  uuid;
  v_wl_base    int;
begin
  -- 1. Suppress the per-row rating-aggregate recompute for the whole flip.
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

  -- 3. Set-based recompute over the affected title_ids.
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

  -- 4b. Flip imported watched flags public (NEW in 2E.1). No aggregate to touch.
  update public.watched_titles
  set visibility = 'public'
  where creator_id = p_creator_id and source = 'letterboxd' and visibility = 'private';
  get diagnostics v_watched = row_count;

  -- 5. Flip imported list containers public — EXCEPT the watchlist sentinel.
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

    delete from public.user_lists where id = v_container_id;
  end if;

  return jsonb_build_object(
    'ratings_published',  coalesce(v_ratings, 0),
    'diary_published',    v_diary,
    'watched_published',  v_watched,
    'lists_published',    v_lists,
    'watchlist_merged',   v_wl_merged,
    'watchlist_skipped',  v_wl_skipped,
    'titles_recomputed',  v_recomputed
  );
end;
$$;

revoke all on function public.publish_letterboxd_import(uuid) from public;
revoke all on function public.publish_letterboxd_import(uuid) from anon, authenticated;
grant execute on function public.publish_letterboxd_import(uuid) to service_role;
