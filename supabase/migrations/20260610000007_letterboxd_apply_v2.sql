-- Letterboxd import APPLY v2 — Phase 2C.1 (items-insert fix).
--
-- The 2C apply failed on the items step with 23P01-adjacent:
--   "ON CONFLICT does not support deferrable unique constraints/exclusion
--    constraints as arbiters".
-- user_list_items carries THREE uniques: (list_id, external_uri) WHERE
-- external_uri IS NOT NULL, (list_id, title_id) WHERE title_id IS NOT NULL, and
-- (list_id, position) which is DEFERRABLE INITIALLY DEFERRED. A no-target
-- ON CONFLICT DO NOTHING asks Postgres to infer arbiters from ALL of them, and
-- it refuses because one is deferrable; and a single explicit arbiter can't
-- cover BOTH of the two partial uniques we actually want to dedupe on. So this
-- v2 drops ON CONFLICT for items and does the idempotency itself: in-batch
-- dedupe + an anti-join against existing rows, then insert at FRESH positions
-- (base + row_number) which never collide with the (list_id, position) unique.
--
-- CREATE OR REPLACE — same signature, same return shape. ONLY step 6 changes;
-- steps 1-5 (job lock, GUC guard, ratings, diary, containers) are byte-identical
-- to 20260610000006.
--
-- Concurrency: the apply is ONE transaction per job and the route's guarded
-- status flip (preview_ready -> applying) serializes applies of a given job, so
-- the anti-join's read-then-insert window is safe within a job. A cross-job race
-- (two different jobs importing into the SAME list at once) could still 23505 on
-- (list_id, position) or a partial unique — that fails the job loudly, which is
-- acceptable for v1.

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

  -- 2. Suppress the per-row rating-aggregate recompute for the whole txn (private
  --    rows never touch the public aggregate; the guard just skips wasted work).
  perform set_config('app.skip_rating_agg', 'on', true);

  -- 3. Ratings. (unchanged from 2C)
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

  -- 4. Diary + reviews. (unchanged from 2C)
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

  -- 5. Containers. (unchanged from 2C — non-deferrable (creator_id, external_uri)
  --    partial unique, so a single explicit arbiter works here.)
  v_c_att := jsonb_array_length(coalesce(v_payload->'containers', '[]'::jsonb));
  insert into public.user_lists (creator_id, name, kind, external_uri, source, visibility)
  select v_creator_id, c.name, 'list', c.external_uri, 'letterboxd', 'private'
  from jsonb_to_recordset(coalesce(v_payload->'containers', '[]'::jsonb))
       as c(name text, external_uri text)
  on conflict (creator_id, external_uri) where external_uri is not null do nothing;
  get diagnostics v_c_ins = row_count;

  -- 6. Items per container — NO ON CONFLICT (see file header: the deferrable
  --    (list_id, position) unique poisons no-target arbiter inference, and no
  --    single explicit arbiter covers both partial uniques). Idempotency is done
  --    by hand: in-batch dedupe, then anti-join existing rows, then insert at
  --    fresh positions. skipped = attempted - inserted therefore folds together
  --    both the in-batch duplicates AND the already-present (re-import) rows.
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
    -- In-batch dedupe: keep the lowest-CSV-position row per (external_uri) and per
    -- (title_id) [non-null only]. title_id-NULL / external_uri-NULL rows are kept
    -- as-is (their partial unique doesn't apply).
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
    -- Anti-join existing rows in THIS list (the two partial uniques).
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

  -- 7. Applied counts + complete. (unchanged from 2C)
  v_applied := jsonb_build_object(
    'ratings',    jsonb_build_object('attempted', v_r_att,  'inserted', v_r_ins,  'skipped', v_r_att  - v_r_ins),
    'diary',      jsonb_build_object('attempted', v_d_att,  'inserted', v_d_ins,  'skipped', v_d_att  - v_d_ins),
    'lists',      jsonb_build_object('attempted', v_c_att,  'inserted', v_c_ins,  'skipped', v_c_att  - v_c_ins),
    'list_items', jsonb_build_object('attempted', v_li_att, 'inserted', v_li_ins, 'skipped', v_li_att - v_li_ins)
  );

  update public.letterboxd_import_jobs
  set counts = v_applied, status = 'completed'
  where id = p_job_id and status = 'applying';

  return v_applied;
end;
$$;

-- Grants re-asserted: service_role ONLY.
revoke all on function public.apply_letterboxd_import(uuid) from public;
revoke all on function public.apply_letterboxd_import(uuid) from anon, authenticated;
grant execute on function public.apply_letterboxd_import(uuid) to service_role;
