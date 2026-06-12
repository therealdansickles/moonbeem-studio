-- Letterboxd import APPLY — Phase 2C (write, private).
--
-- Turns a preview_ready job into rows in the four content surfaces, all
-- visibility='private', source='letterboxd'. Everything is structurally
-- idempotent (re-import is safe) and never downgrades or touches existing rows:
--   * dedupe is ON CONFLICT DO NOTHING on the Phase-0/2A partial uniques;
--   * the apply pins its input at PREVIEW time (the new payload column) and
--     never re-parses or re-matches;
--   * private rows never affect any title's PUBLIC rating aggregate, so the
--     per-row agg recompute is suppressed for the whole apply (GUC) and no
--     recompute pass runs afterward.

-- (a) Pin column. The full normalized+matched rows the apply replays, written at
--     preview time. NEVER shipped to the client (the GET route does not select
--     it); the display preview stays in `preview`. Nullable, no default →
--     metadata-only add.
alter table public.letterboxd_import_jobs add column if not exists payload jsonb;

-- (b) apply_letterboxd_import(p_job_id) — ONE transaction (a single plpgsql
--     call is one txn). Called only by the apply route via the service-role
--     client, AFTER the route has flipped status to 'applying'.
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

  -- 2. Suppress the per-row rating-aggregate recompute for the whole txn. The
  --    imported ratings are visibility='private', which the aggregate trigger
  --    ignores entirely (it sums public rows only), so there is nothing to
  --    recompute — the guard just skips the wasted per-row work. set_config(
  --    is_local => true) reverts at txn end; app.* is a USERSET placeholder so
  --    service_role may set it at runtime.
  perform set_config('app.skip_rating_agg', 'on', true);

  -- 3. Ratings. rating is NOT NULL + half-step CHECK; the worker only pins rows
  --    with a valid rating, the WHERE is defensive. tmdb_id pinned NULL.
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

  -- 4. Diary + reviews (both are diary_entries). watched_on is NOT NULL — the
  --    worker drops null-watched rows, the WHERE is defensive. rating/review_text
  --    nullable; contains_spoilers/rewatch default false.
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

  -- 5. Containers: the CSV lists + the Watchlist container, ALL kind='list'
  --    (the imported watchlist is its own private list named "Watchlist" with
  --    external_uri 'lb://watchlist' — it never touches the native kind='watchlist').
  --    Conflict on the partial (creator_id, external_uri) unique.
  v_c_att := jsonb_array_length(coalesce(v_payload->'containers', '[]'::jsonb));
  insert into public.user_lists (creator_id, name, kind, external_uri, source, visibility)
  select v_creator_id, c.name, 'list', c.external_uri, 'letterboxd', 'private'
  from jsonb_to_recordset(coalesce(v_payload->'containers', '[]'::jsonb))
       as c(name text, external_uri text)
  on conflict (creator_id, external_uri) where external_uri is not null do nothing;
  get diagnostics v_c_ins = row_count;

  -- 6. Items per container. Resolve the now-existing container id (insert above
  --    OR a prior import), append AFTER the current max position in CSV order,
  --    dedupe on the list's (list_id, external_uri)/(list_id, title_id) uniques.
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
    select v_list_id, v_creator_id, it.title_id, null, it.raw_title, it.raw_year, it.external_uri,
           v_base + (row_number() over (order by it.position))::int,
           'letterboxd'
    from jsonb_to_recordset(coalesce(v_container->'items', '[]'::jsonb))
         as it(title_id uuid, external_uri text, raw_title text, raw_year int, position int)
    on conflict do nothing;
    get diagnostics v_n = row_count;
    v_li_ins := v_li_ins + v_n;
  end loop;

  -- 7. Applied counts + complete. Guarded WHERE status='applying'.
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

-- (c) Grants: service_role ONLY (the apply route calls it through the
--     service-role client; anon/authenticated must never reach the writer).
revoke all on function public.apply_letterboxd_import(uuid) from public;
revoke all on function public.apply_letterboxd_import(uuid) from anon, authenticated;
grant execute on function public.apply_letterboxd_import(uuid) to service_role;
