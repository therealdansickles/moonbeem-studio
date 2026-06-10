-- Letterboxd foundations — Phase 0 (DRAFT — staged, NOT applied).
--
-- Grounded in the 2026-06-10 recon. Revises the May-15 mega-migration spec
-- per three decisions:
--   (1) NO rename of creators.moonbeem_handle — it stays. We only add the
--       case-insensitive UNIQUE index the app/RPC layer already assumes.
--   (2) NO reserved_handles table — reservation uses the live
--       creators.reserved_for_letterboxd_username column + the existing stub
--       pattern (find_or_create_stub_creator / claim flow).
--   (3) user_lists is the GENERAL user-list system; watchlist is a list kind.
--       user_top_titles / Top 12 are untouched by this migration.
--
-- ATOMICITY POSTURE (changed after adversarial review): the project has a
-- documented Supabase partial-commit footgun (failed multi-statement
-- migrations can leave earlier statements committed). So this file does NOT
-- rely on whole-file rollback for safety. Two defenses:
--   * Part A2 is GATE-FIRST: the unresolved-row check runs BEFORE any stub is
--     minted, so an unfilled DECISION block mutates nothing.
--   * every CREATE TRIGGER / CREATE POLICY is preceded by DROP ... IF EXISTS,
--     and tables/indexes use IF NOT EXISTS, so a partial apply is re-runnable.
--
-- A3 guards ALL THREE stub-absorb paths against reserved Letterboxd stubs:
-- claim_handle (A3a), merge_stub_creator (A3b), and mark_social_verified_and_
-- merge (A3c — the third path the original Phase-0 scope missed; see report).
--
-- ============================================================================
-- ROW [1] RESOLVED (ruling: OPTION A) — fan_edit aa42f847-c771-4bfa-95b9-
-- 0bc242c98979 (YouTube short /shorts/fParOEvJwec) is attributed to
-- @searchlightpictures (channel "SearchlightPictures", channelId
-- UCor9rW6PgxSQ9vUPWQdnaYQ; video "Becoming Ann Lee | THE TESTAMENT OF ANN
-- LEE" — matches the fan_edit title). Recovered read-only from the public
-- watch page on 2026-06-10 (HTTP 200, isPrivate=false). The A2 pre-gate now
-- passes; the file is runnable pending the apply gate.
-- ============================================================================


-- ############################################################################
-- PART A — integrity tightening
-- ############################################################################

-- A1. Case-insensitive UNIQUE on moonbeem_handle.
--     Keeps the existing raw UNIQUE (creators_moonbeem_handle_key) AND the
--     non-unique idx_creators_moonbeem_handle. This adds the case-insensitive
--     guarantee that claim_handle / find_or_create_stub_creator rely on in
--     application logic but the DB never enforced.
--     Pre-flight P1: SELECT lower(moonbeem_handle), count(*) FROM creators
--     GROUP BY 1 HAVING count(*) > 1  ->  0 rows across 208 creators, so this
--     index builds cleanly. NOTE (conscious choice): non-partial, so it spans
--     soft-deleted creators — consistent with the existing raw UNIQUE.
create unique index if not exists creators_moonbeem_handle_lower_unique
  on public.creators (lower(moonbeem_handle));


-- A2. Backfill fan_edits.creator_id (7 NULLs) then SET NOT NULL.
--     creator_id was made nullable in 20260427000003 ("tighten back to NOT
--     NULL in a future migration once all edits are creator-linked") — this is
--     that migration. 6 of 7 NULLs resolve from their own Instagram handle via
--     find_or_create_stub_creator(handle, platform) (idempotent on
--     (platform, lower(handle))). The 7th has no handle — see DECISION block.
do $$
declare
  v_cid uuid;
begin
  -- ==========================================================================
  -- ROW [1] RESOLVED (ruling: OPTION A) — fan_edit aa42f847 "The Testament of
  --   Ann Lee" (2025).  The YouTube short /shorts/fParOEvJwec was fetched
  --   read-only (HTTP 200, isPrivate=false) and its channel recovered:
  --   @searchlightpictures ("SearchlightPictures", channelId
  --   UCor9rW6PgxSQ9vUPWQdnaYQ; video "Becoming Ann Lee | THE TESTAMENT OF ANN
  --   LEE"). 'youtube' is already an accepted creator_socials platform
  --   (creator_socials_platform_check, 20260506000006:31), so no platform
  --   CHECK change is needed (see report re: the still-deferred 'reddit').
  --   Runs FIRST, before the 6 IG backfills, so the A2 pre-gate below passes.
  -- ==========================================================================
  v_cid := public.find_or_create_stub_creator('searchlightpictures', 'youtube');
  update public.fan_edits set creator_id = v_cid
    where id = 'aa42f847-c771-4bfa-95b9-0bc242c98979' and creator_id is null;
  raise notice 'A2 [1] aa42f847 searchlightpictures (youtube) -> %', v_cid;

  -- A2 PRE-GATE — mutate nothing until row [1] is resolved.
  -- (a) the undecided row must be resolved before any stub is minted.
  if exists (
    select 1 from public.fan_edits
    where id = 'aa42f847-c771-4bfa-95b9-0bc242c98979' and creator_id is null
  ) then
    raise exception
      'A2 pre-gate: fan_edit aa42f847 is unresolved — fill the DECISION block above before applying (nothing has been mutated)';
  end if;
  -- (b) drift guard: no NULL creator_id outside the 7 recon rows.
  if exists (
    select 1 from public.fan_edits
    where creator_id is null
      and id not in (
        'aa42f847-c771-4bfa-95b9-0bc242c98979',
        '3b71c1a9-9045-4610-ada5-16c616c07d74',
        'c18ad64a-724f-46c5-a7fe-68f6cc9bb403',
        '4bcbf379-21a1-49c8-9230-5f169156d54b',
        'bfde81d8-3cb9-4aa8-86f8-d6c3f01b3dd4',
        '7c54b946-32d0-4283-9988-c2a9c020bbd7',
        '1f2bf09e-5f36-4147-bb72-3684e64a044f'
      )
  ) then
    raise exception
      'A2 pre-gate: NULL creator_id found outside the 7 recon rows — re-run recon before applying';
  end if;

  -- The 6 explicit, idempotent backfills (safe to re-run: WHERE creator_id IS
  -- NULL makes a second pass a no-op; find_or_create reuses existing stubs).

  -- [2] "Erupcja" — IG @imthat.girlfriend  (mints a fresh stub)
  v_cid := public.find_or_create_stub_creator('imthat.girlfriend', 'instagram');
  update public.fan_edits set creator_id = v_cid
    where id = '3b71c1a9-9045-4610-ada5-16c616c07d74' and creator_id is null;
  raise notice 'A2 [2] 3b71c1a9 imthat.girlfriend -> %', v_cid;

  -- [3] "Erupcja" — IG @dan_sickles  (REUSES existing stub fc098b35; row is
  --     soft-deleted but SET NOT NULL still requires a non-null creator_id)
  v_cid := public.find_or_create_stub_creator('dan_sickles', 'instagram');
  update public.fan_edits set creator_id = v_cid
    where id = 'c18ad64a-724f-46c5-a7fe-68f6cc9bb403' and creator_id is null;
  raise notice 'A2 [3] c18ad64a dan_sickles -> %', v_cid;

  -- [4] "Erupcja" — IG @velvet.spoon  (REUSES existing stub 75e8bc19)
  v_cid := public.find_or_create_stub_creator('velvet.spoon', 'instagram');
  update public.fan_edits set creator_id = v_cid
    where id = '4bcbf379-21a1-49c8-9230-5f169156d54b' and creator_id is null;
  raise notice 'A2 [4] 4bcbf379 velvet.spoon -> %', v_cid;

  -- [5] "Erupcja" — IG @justlikewerefamous  (mints a fresh stub)
  v_cid := public.find_or_create_stub_creator('justlikewerefamous', 'instagram');
  update public.fan_edits set creator_id = v_cid
    where id = 'bfde81d8-3cb9-4aa8-86f8-d6c3f01b3dd4' and creator_id is null;
  raise notice 'A2 [5] bfde81d8 justlikewerefamous -> %', v_cid;

  -- [6] "Erupcja" — IG @polishculturalinstituteny  (mints a fresh stub)
  v_cid := public.find_or_create_stub_creator('polishculturalinstituteny', 'instagram');
  update public.fan_edits set creator_id = v_cid
    where id = '7c54b946-32d0-4283-9988-c2a9c020bbd7' and creator_id is null;
  raise notice 'A2 [6] 7c54b946 polishculturalinstituteny -> %', v_cid;

  -- [7] "Erupcja" — IG @justlikewerefamous  (REUSES the stub minted in [5])
  v_cid := public.find_or_create_stub_creator('justlikewerefamous', 'instagram');
  update public.fan_edits set creator_id = v_cid
    where id = '1f2bf09e-5f36-4147-bb72-3684e64a044f' and creator_id is null;
  raise notice 'A2 [7] 1f2bf09e justlikewerefamous -> %', v_cid;
end $$;

-- A2 confirmation — re-select the 7 target rows and surface their linkage.
do $$
declare
  r record;
begin
  raise notice 'A2 confirmation (id -> creator_id / stub moonbeem_handle):';
  for r in
    select fe.id, fe.creator_id, c.moonbeem_handle
    from public.fan_edits fe
    left join public.creators c on c.id = fe.creator_id
    where fe.id in (
      'aa42f847-c771-4bfa-95b9-0bc242c98979',
      '3b71c1a9-9045-4610-ada5-16c616c07d74',
      'c18ad64a-724f-46c5-a7fe-68f6cc9bb403',
      '4bcbf379-21a1-49c8-9230-5f169156d54b',
      'bfde81d8-3cb9-4aa8-86f8-d6c3f01b3dd4',
      '7c54b946-32d0-4283-9988-c2a9c020bbd7',
      '1f2bf09e-5f36-4147-bb72-3684e64a044f'
    )
    order by fe.id
  loop
    raise notice '  % -> % / %', r.id, coalesce(r.creator_id::text, 'NULL'),
      coalesce(r.moonbeem_handle, '(none)');
  end loop;
end $$;

-- A2 final gate (belt) — prove zero NULLs remain before tightening.
do $$
declare
  v_nulls int;
begin
  select count(*) into v_nulls from public.fan_edits where creator_id is null;
  if v_nulls > 0 then
    raise exception
      'A2 final gate: % fan_edits still have creator_id IS NULL', v_nulls;
  end if;
end $$;

alter table public.fan_edits
  alter column creator_id set not null;


-- A3. Claim guard — a reserved Letterboxd stub is claimable ONLY via the
--     Phase-3 verified-import flow, never the open handle picker, the social-
--     heuristic merge, or social verification. Pre-flight P3: 0 creators
--     currently have reserved_for_letterboxd_username NOT NULL, so all three
--     guards are inert today and become load-bearing once Phase 3 seeds
--     reserved stubs.

-- A3a. claim_handle — add the reserved check to branch 2 (attach-to-stub).
--      Body-only change (signature unchanged) -> CREATE OR REPLACE is safe.
--      DIFF vs 20260506000005: new v_creator_reserved declare; SELECT also
--      reads reserved_for_letterboxd_username; branch 2 RAISEs 'handle_reserved'
--      when it is NOT NULL, before the UPDATE.
create or replace function public.claim_handle(p_handle text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_creator_id uuid;
  v_creator_user_id uuid;
  v_creator_reserved text;   -- NEW
  v_existing_handle text;
  v_normalized text;
begin
  if v_user_id is null then
    raise exception 'not_authenticated';
  end if;

  v_normalized := lower(trim(p_handle));
  if v_normalized !~ '^[a-z0-9_]{3,30}$' then
    raise exception 'invalid_handle';
  end if;

  select handle into v_existing_handle
    from public.users where id = v_user_id;
  if v_existing_handle is not null then
    if lower(v_existing_handle) = v_normalized then
      return;
    end if;
    raise exception 'user_already_has_handle';
  end if;

  select id, user_id, reserved_for_letterboxd_username        -- NEW column
    into v_creator_id, v_creator_user_id, v_creator_reserved
    from public.creators
    where lower(moonbeem_handle) = v_normalized
      and deleted_at is null
    for update;

  if v_creator_id is null then
    begin
      insert into public.creators (user_id, moonbeem_handle, is_claimed, is_stub)
        values (v_user_id, v_normalized, true, false);
    exception when unique_violation then
      raise exception 'handle_taken';
    end;
  elsif v_creator_user_id is null then
    -- NEW GUARD: reserved Letterboxd stubs route through the Phase-3 verified
    -- flow only. Surface a distinct error the /api/users/handle/claim route
    -- can map to a "this handle is reserved — verify via Letterboxd" message.
    if v_creator_reserved is not null then
      raise exception 'handle_reserved';
    end if;
    update public.creators
      set user_id = v_user_id,
          is_claimed = true,
          is_stub = false
      where id = v_creator_id;
  else
    raise exception 'handle_taken';
  end if;

  begin
    update public.users
      set handle = v_normalized
      where id = v_user_id;
  exception when unique_violation then
    raise exception 'handle_taken';
  end;
end;
$$;

grant execute on function public.claim_handle(text) to authenticated;

-- A3b. merge_stub_creator — its target SELECT (is_stub, user_id IS NULL,
--      deleted_at IS NULL) DOES reach reserved stubs: nothing excludes a
--      reserved row, and a reserved Letterboxd stub could carry a
--      creator_socials handle that a caller matches via the heuristics.
--      DIFF vs 20260528000002: one new check immediately after the
--      stub_not_claimable check. Everything else preserved verbatim
--      (normalize_handle_for_match is unchanged and not redefined here).
create or replace function public.merge_stub_creator(
  p_stub_creator_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_user_creator_id uuid;
  v_user_moonbeem_handle text;
  v_stub creators%rowtype;
  v_match_exists boolean := false;
begin
  if v_user_id is null then
    raise exception 'not_authenticated';
  end if;

  select id, moonbeem_handle
    into v_user_creator_id, v_user_moonbeem_handle
    from public.creators
    where user_id = v_user_id and deleted_at is null
    limit 1;

  if v_user_creator_id is null then
    raise exception 'no_creator_for_user';
  end if;

  select * into v_stub
    from public.creators
    where id = p_stub_creator_id
      and is_stub = true
      and user_id is null
      and deleted_at is null
    for update;

  if v_stub.id is null then
    raise exception 'stub_not_claimable';
  end if;

  -- NEW GUARD: reserved Letterboxd stubs are claimable ONLY via the Phase-3
  -- verified flow, not this social-handle heuristic merge.
  if v_stub.reserved_for_letterboxd_username is not null then
    raise exception 'handle_reserved';
  end if;

  if v_user_moonbeem_handle is not null then
    select true into v_match_exists
      from public.creator_socials cs
      where cs.creator_id = p_stub_creator_id
        and cs.platform in ('tiktok','instagram','twitter','youtube')
        and cs.handle is not null
        and public.normalize_handle_for_match(cs.handle)
            = public.normalize_handle_for_match(v_user_moonbeem_handle)
      limit 1;
  end if;

  if v_match_exists is not true then
    select true into v_match_exists
      from public.creator_socials cs_user
      inner join public.creator_socials cs_stub
        on cs_user.platform = cs_stub.platform
        and (
          lower(cs_user.handle) = lower(cs_stub.handle)
          or public.normalize_handle_for_match(cs_user.handle)
             = public.normalize_handle_for_match(cs_stub.handle)
        )
      where cs_user.creator_id = v_user_creator_id
        and cs_user.verified_at is not null
        and cs_user.handle is not null
        and cs_stub.creator_id = p_stub_creator_id
        and cs_stub.handle is not null
        and cs_stub.platform in ('tiktok','instagram','twitter','youtube')
      limit 1;
  end if;

  if v_match_exists is not true then
    raise exception 'no_claim_match';
  end if;

  update public.creator_socials
    set creator_id = v_user_creator_id
    where creator_id = p_stub_creator_id;

  update public.fan_edits
    set creator_id = v_user_creator_id
    where creator_id = p_stub_creator_id;

  update public.creator_earnings
    set creator_id = v_user_creator_id,
        claimed = true
    where creator_id = p_stub_creator_id
      and not exists (
        select 1 from public.creator_earnings dup
        where dup.creator_id = v_user_creator_id
          and dup.fan_edit_id = creator_earnings.fan_edit_id
          and dup.calculation_date = creator_earnings.calculation_date
      );
  delete from public.creator_earnings
    where creator_id = p_stub_creator_id;

  update public.creators
    set deleted_at = now()
    where id = p_stub_creator_id and deleted_at is null;
end;
$$;

revoke execute on function public.merge_stub_creator(uuid) from public;
grant execute on function public.merge_stub_creator(uuid) to authenticated;

-- A3c. mark_social_verified_and_merge — the THIRD stub-absorb path (social
--      verification). Its absorb branch reattaches the old creator's socials/
--      fan_edits/earnings and soft-deletes it; nothing excludes a reserved
--      stub, so it must carry the same guard. DIFF vs 20260508000004: one new
--      check right after v_old_creator_id is computed, before any mutation.
--      Everything else preserved verbatim. (Scope note: the original Phase-0
--      prompt named only claim_handle + merge_stub_creator; this third guard
--      was added after the adversarial review found this path — see report.)
create or replace function public.mark_social_verified_and_merge(
  p_platform text,
  p_handle text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_user_creator_id uuid;
  v_normalized text;
  v_social_row public.creator_socials%rowtype;
  v_old_creator_id uuid;
begin
  if v_user_id is null then
    raise exception 'not_authenticated';
  end if;
  if p_platform not in ('tiktok', 'instagram', 'twitter', 'youtube') then
    raise exception 'invalid_platform';
  end if;
  v_normalized := lower(trim(p_handle));
  if v_normalized = '' or v_normalized !~ '^[a-z0-9_.]{1,30}$' then
    raise exception 'invalid_handle';
  end if;

  select id into v_user_creator_id
    from public.creators
    where user_id = v_user_id and deleted_at is null
    limit 1;
  if v_user_creator_id is null then
    raise exception 'no_creator';
  end if;

  select * into v_social_row
    from public.creator_socials
    where platform = p_platform
      and lower(handle) = v_normalized
    for update;
  if v_social_row.id is null then
    raise exception 'no_social_row';
  end if;
  if v_social_row.verification_code is null then
    raise exception 'no_active_verification';
  end if;
  if v_social_row.verification_started_at is null
     or v_social_row.verification_started_at < now() - interval '24 hours' then
    raise exception 'verification_expired';
  end if;

  v_old_creator_id := v_social_row.creator_id;

  -- NEW GUARD: if the social belongs to a reserved Letterboxd stub, refuse to
  -- absorb it here — Phase-3 verified flow is the only claim path. Placed
  -- before the verification UPDATE so the whole operation aborts cleanly.
  -- PHASE 3 must revisit skip-vs-raise here once reserved stubs exist — raising
  -- inside social verification blocks an otherwise-legitimate verification (the
  -- user's social proof is valid; only the stub-absorb should be suppressed).
  if v_old_creator_id is not null and v_old_creator_id <> v_user_creator_id then
    if exists (
      select 1 from public.creators
      where id = v_old_creator_id
        and reserved_for_letterboxd_username is not null
    ) then
      raise exception 'handle_reserved';
    end if;
  end if;

  update public.creator_socials
    set verified_at = now(),
        is_verified = true,
        verification_code = null,
        verification_started_at = null,
        creator_id = v_user_creator_id
    where id = v_social_row.id;

  if v_old_creator_id is not null and v_old_creator_id <> v_user_creator_id then
    update public.creator_socials
      set creator_id = v_user_creator_id
      where creator_id = v_old_creator_id;

    update public.fan_edits
      set creator_id = v_user_creator_id
      where creator_id = v_old_creator_id;

    update public.creator_earnings
      set creator_id = v_user_creator_id,
          claimed = true
      where creator_id = v_old_creator_id
        and not exists (
          select 1 from public.creator_earnings dup
          where dup.creator_id = v_user_creator_id
            and dup.fan_edit_id = creator_earnings.fan_edit_id
            and dup.calculation_date = creator_earnings.calculation_date
        );
    delete from public.creator_earnings
      where creator_id = v_old_creator_id;

    update public.creators
      set deleted_at = now()
      where id = v_old_creator_id and deleted_at is null;
  end if;

  return v_user_creator_id;
end;
$$;

revoke execute on function public.mark_social_verified_and_merge(text, text) from public;
grant execute on function public.mark_social_verified_and_merge(text, text) to authenticated;


-- ############################################################################
-- PART B — Letterboxd + surfaces tables (all RLS'd, all inert until later
-- phases). Conventions (applied where coherent — see staging report for the
-- per-table deviations that were judgment calls):
--   creator_id uuid NOT NULL FK -> creators(id) ON DELETE CASCADE
--   title_id   uuid NULL    FK -> titles(id)   ON DELETE SET NULL  (film rows)
--   tmdb_id bigint / raw_title text / raw_year int  (preserve unmatched films;
--     match must respect the composite unique titles(tmdb_id, media_type) with
--     media_type='movie' — Letterboxd is films)
--   external_uri text dedupe key, UNIQUE partial WHERE external_uri IS NOT NULL
--   source     text NOT NULL DEFAULT 'native'  CHECK (source IN ('native','letterboxd'))
--   visibility text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','public'))
--   created_at / updated_at timestamptz NOT NULL DEFAULT now()
-- updated_at is kept fresh by the repo's public.set_updated_at() trigger fn.
-- ############################################################################

-- B1. diary_entries — a watch-log row; a "review" is a diary entry with
--     review_text (Letterboxd's model).
create table if not exists public.diary_entries (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.creators(id) on delete cascade,
  title_id uuid references public.titles(id) on delete set null,
  tmdb_id bigint,
  raw_title text,
  raw_year int,
  external_uri text,
  watched_on date not null,
  rewatch boolean not null default false,
  -- 0.5–5.0 range + half-step enforcement (Letterboxd uses 0.5 increments).
  rating numeric(2,1) check (rating >= 0.5 and rating <= 5.0 and rating * 2 = floor(rating * 2)),
  review_text text,
  contains_spoilers boolean not null default false,
  source text not null default 'native' check (source in ('native','letterboxd')),
  visibility text not null default 'private' check (visibility in ('private','public')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists diary_entries_external_uri_unique
  on public.diary_entries (external_uri) where external_uri is not null;
create index if not exists idx_diary_entries_creator on public.diary_entries (creator_id);
create index if not exists idx_diary_entries_title on public.diary_entries (title_id) where title_id is not null;

-- B2. title_ratings — the CURRENT rating per creator per title.
create table if not exists public.title_ratings (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.creators(id) on delete cascade,
  title_id uuid references public.titles(id) on delete set null,
  tmdb_id bigint,
  raw_title text,
  raw_year int,
  external_uri text,
  -- 0.5–5.0 range + half-step enforcement (Letterboxd uses 0.5 increments).
  rating numeric(2,1) not null check (rating >= 0.5 and rating <= 5.0 and rating * 2 = floor(rating * 2)),
  rated_on date,
  source text not null default 'native' check (source in ('native','letterboxd')),
  visibility text not null default 'private' check (visibility in ('private','public')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- matched rows: one current rating per (creator, title).
create unique index if not exists title_ratings_creator_title_unique
  on public.title_ratings (creator_id, title_id) where title_id is not null;
-- unmatched rows (title_id NULL): dedupe by tmdb_id so re-imports don't pile
-- up duplicate "current" ratings before the catalog match lands.
create unique index if not exists title_ratings_creator_tmdb_unique
  on public.title_ratings (creator_id, tmdb_id) where title_id is null and tmdb_id is not null;
create unique index if not exists title_ratings_external_uri_unique
  on public.title_ratings (external_uri) where external_uri is not null;

-- B3. user_lists — general user-list container; watchlist is a kind.
--     Container, so NO title/tmdb/raw_* columns (those live on items).
--     external_uri here is the Letterboxd LIST url (list-level dedupe).
create table if not exists public.user_lists (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.creators(id) on delete cascade,
  name text not null,
  description text,
  kind text not null default 'list' check (kind in ('list','watchlist')),
  is_ranked boolean not null default false,
  external_uri text,
  source text not null default 'native' check (source in ('native','letterboxd')),
  visibility text not null default 'private' check (visibility in ('private','public')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- one watchlist per creator
create unique index if not exists user_lists_one_watchlist_per_creator
  on public.user_lists (creator_id) where kind = 'watchlist';
create unique index if not exists user_lists_external_uri_unique
  on public.user_lists (external_uri) where external_uri is not null;

-- B4. user_list_items — film rows inside a list.
--     NOTE (ruling): the redundant item-level `visibility` column is DROPPED
--     (public read gates through the parent list's visibility; a per-item
--     column RLS ignores is a trap). creator_id and source are KEPT.
--     creator_id is denormalized vs user_lists.creator_id and RLS owns these
--     rows THROUGH the parent list, so the writer must set item.creator_id =
--     the parent list's creator_id.
create table if not exists public.user_list_items (
  id uuid primary key default gen_random_uuid(),
  list_id uuid not null references public.user_lists(id) on delete cascade,
  creator_id uuid not null references public.creators(id) on delete cascade,
  title_id uuid references public.titles(id) on delete set null,
  tmdb_id bigint,
  raw_title text,
  raw_year int,
  external_uri text,
  position int not null,
  notes text,
  source text not null default 'native' check (source in ('native','letterboxd')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- deferrable so a whole-list reorder can shuffle positions in one tx.
  -- NOTE for consumers: a DEFERRABLE unique cannot be an ON CONFLICT arbiter;
  -- upsert on (list_id, external_uri) or reorder-then-insert instead.
  constraint user_list_items_list_position_unique
    unique (list_id, position) deferrable initially deferred
);
create unique index if not exists user_list_items_list_external_uri_unique
  on public.user_list_items (list_id, external_uri) where external_uri is not null;
create index if not exists idx_user_list_items_creator on public.user_list_items (creator_id);
create index if not exists idx_user_list_items_list on public.user_list_items (list_id);

-- B5. letterboxd_import_jobs — pipeline state. Owned by user_id (a job can
--     precede a claimed creator), so creator_id is NULLABLE here.
--     Phase-3 apply MUST re-verify job.creator_id is owned by job.user_id
--     before writing creator-scoped rows (RLS here only checks user_id).
create table if not exists public.letterboxd_import_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  creator_id uuid references public.creators(id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending','parsing','preview_ready','applying','completed','failed')),
  r2_path text,
  counts jsonb,
  preview jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_letterboxd_import_jobs_user on public.letterboxd_import_jobs (user_id);

-- B6. letterboxd_sync_state — one row per creator (Phase 4 consumer; inert).
create table if not exists public.letterboxd_sync_state (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.creators(id) on delete cascade,
  letterboxd_username text not null,
  last_synced_at timestamptz,
  etag text,
  last_modified text,
  status text not null default 'paused'
    check (status in ('active','paused','revoked','error')),
  consecutive_failures int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint letterboxd_sync_state_creator_unique unique (creator_id)
);

-- B7. letterboxd_follow_queue — friend-follow resolution queue (Phase 4
--     consumer; inert). NOTE: the May-spec exact shape was not available in
--     this session; this is a best-reconstruction — confirm columns in review.
create table if not exists public.letterboxd_follow_queue (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.creators(id) on delete cascade,
  letterboxd_username text not null,
  target_creator_id uuid references public.creators(id) on delete set null,
  status text not null default 'pending'
    check (status in ('pending','matched','followed','skipped','failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint letterboxd_follow_queue_unique unique (creator_id, letterboxd_username)
);

-- updated_at triggers (mirror creators / notification_preferences usage of
-- public.set_updated_at()). DROP-then-CREATE so a partial re-apply is safe.
drop trigger if exists trg_diary_entries_updated_at on public.diary_entries;
create trigger trg_diary_entries_updated_at
  before update on public.diary_entries
  for each row execute function public.set_updated_at();
drop trigger if exists trg_title_ratings_updated_at on public.title_ratings;
create trigger trg_title_ratings_updated_at
  before update on public.title_ratings
  for each row execute function public.set_updated_at();
drop trigger if exists trg_user_lists_updated_at on public.user_lists;
create trigger trg_user_lists_updated_at
  before update on public.user_lists
  for each row execute function public.set_updated_at();
drop trigger if exists trg_user_list_items_updated_at on public.user_list_items;
create trigger trg_user_list_items_updated_at
  before update on public.user_list_items
  for each row execute function public.set_updated_at();
drop trigger if exists trg_letterboxd_import_jobs_updated_at on public.letterboxd_import_jobs;
create trigger trg_letterboxd_import_jobs_updated_at
  before update on public.letterboxd_import_jobs
  for each row execute function public.set_updated_at();
drop trigger if exists trg_letterboxd_sync_state_updated_at on public.letterboxd_sync_state;
create trigger trg_letterboxd_sync_state_updated_at
  before update on public.letterboxd_sync_state
  for each row execute function public.set_updated_at();
drop trigger if exists trg_letterboxd_follow_queue_updated_at on public.letterboxd_follow_queue;
create trigger trg_letterboxd_follow_queue_updated_at
  before update on public.letterboxd_follow_queue
  for each row execute function public.set_updated_at();


-- ----------------------------------------------------------------------------
-- RLS — mirrors the repo idioms:
--   owner-through-parent EXISTS join  ->  curated_list_titles (20260514000004)
--   visibility public read            ->  curated_lists "is_visible = true"
--   ownership predicate               ->  creators "auth.uid() = user_id"
-- Service role bypasses RLS (BYPASSRLS) for the import pipeline — no explicit
-- service policy needed, matching how clips/stills/curated_* are handled.
-- All policies DROP-then-CREATE for partial-re-apply safety.
-- ----------------------------------------------------------------------------

-- diary_entries — owner all (own creator_id == owner) + public read.
alter table public.diary_entries enable row level security;
drop policy if exists "diary_entries owner all" on public.diary_entries;
create policy "diary_entries owner all"
  on public.diary_entries for all
  using (exists (select 1 from public.creators c
                 where c.id = diary_entries.creator_id and c.user_id = auth.uid()))
  with check (exists (select 1 from public.creators c
                 where c.id = diary_entries.creator_id and c.user_id = auth.uid()));
drop policy if exists "diary_entries public read" on public.diary_entries;
create policy "diary_entries public read"
  on public.diary_entries for select
  using (visibility = 'public');

-- title_ratings — owner all + public read.
alter table public.title_ratings enable row level security;
drop policy if exists "title_ratings owner all" on public.title_ratings;
create policy "title_ratings owner all"
  on public.title_ratings for all
  using (exists (select 1 from public.creators c
                 where c.id = title_ratings.creator_id and c.user_id = auth.uid()))
  with check (exists (select 1 from public.creators c
                 where c.id = title_ratings.creator_id and c.user_id = auth.uid()));
drop policy if exists "title_ratings public read" on public.title_ratings;
create policy "title_ratings public read"
  on public.title_ratings for select
  using (visibility = 'public');

-- user_lists — owner all + public read.
alter table public.user_lists enable row level security;
drop policy if exists "user_lists owner all" on public.user_lists;
create policy "user_lists owner all"
  on public.user_lists for all
  using (exists (select 1 from public.creators c
                 where c.id = user_lists.creator_id and c.user_id = auth.uid()))
  with check (exists (select 1 from public.creators c
                 where c.id = user_lists.creator_id and c.user_id = auth.uid()));
drop policy if exists "user_lists public read" on public.user_lists;
create policy "user_lists public read"
  on public.user_lists for select
  using (visibility = 'public');

-- user_list_items — ownership is gated THROUGH THE PARENT LIST (not the
-- denormalized item.creator_id), matching the curated_list_titles idiom. This
-- closes the cross-tenant write hole the review found: a caller can only write
-- items into lists their own creator owns. Public read follows the parent
-- list's visibility (the redundant per-item visibility column was dropped per
-- ruling).
alter table public.user_list_items enable row level security;
drop policy if exists "user_list_items owner all" on public.user_list_items;
create policy "user_list_items owner all"
  on public.user_list_items for all
  using (exists (select 1 from public.user_lists l
                 join public.creators c on c.id = l.creator_id
                 where l.id = user_list_items.list_id and c.user_id = auth.uid()))
  with check (exists (select 1 from public.user_lists l
                 join public.creators c on c.id = l.creator_id
                 where l.id = user_list_items.list_id and c.user_id = auth.uid()));
drop policy if exists "user_list_items public read" on public.user_list_items;
create policy "user_list_items public read"
  on public.user_list_items for select
  using (exists (select 1 from public.user_lists l
                 where l.id = user_list_items.list_id and l.visibility = 'public'));

-- letterboxd_import_jobs — owner-only (by user_id), no public read.
alter table public.letterboxd_import_jobs enable row level security;
drop policy if exists "letterboxd_import_jobs owner all" on public.letterboxd_import_jobs;
create policy "letterboxd_import_jobs owner all"
  on public.letterboxd_import_jobs for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- letterboxd_sync_state — owner-only (through creator), no public read.
alter table public.letterboxd_sync_state enable row level security;
drop policy if exists "letterboxd_sync_state owner all" on public.letterboxd_sync_state;
create policy "letterboxd_sync_state owner all"
  on public.letterboxd_sync_state for all
  using (exists (select 1 from public.creators c
                 where c.id = letterboxd_sync_state.creator_id and c.user_id = auth.uid()))
  with check (exists (select 1 from public.creators c
                 where c.id = letterboxd_sync_state.creator_id and c.user_id = auth.uid()));

-- letterboxd_follow_queue — owner-only (through creator), no public read.
alter table public.letterboxd_follow_queue enable row level security;
drop policy if exists "letterboxd_follow_queue owner all" on public.letterboxd_follow_queue;
create policy "letterboxd_follow_queue owner all"
  on public.letterboxd_follow_queue for all
  using (exists (select 1 from public.creators c
                 where c.id = letterboxd_follow_queue.creator_id and c.user_id = auth.uid()))
  with check (exists (select 1 from public.creators c
                 where c.id = letterboxd_follow_queue.creator_id and c.user_id = auth.uid()));


-- ############################################################################
-- PART D — verification gate. RAISE (aborting the migration) if any invariant
-- is missing.
-- ############################################################################
do $$
begin
  -- A1: the case-insensitive unique index exists.
  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and indexname = 'creators_moonbeem_handle_lower_unique'
  ) then
    raise exception 'Part D: creators_moonbeem_handle_lower_unique is missing';
  end if;

  -- A2: no fan_edits.creator_id NULLs remain.
  if exists (select 1 from public.fan_edits where creator_id is null) then
    raise exception 'Part D: fan_edits.creator_id still contains NULLs';
  end if;

  -- B: all seven Part B tables exist.
  if to_regclass('public.diary_entries')         is null then raise exception 'Part D: diary_entries missing'; end if;
  if to_regclass('public.title_ratings')         is null then raise exception 'Part D: title_ratings missing'; end if;
  if to_regclass('public.user_lists')            is null then raise exception 'Part D: user_lists missing'; end if;
  if to_regclass('public.user_list_items')       is null then raise exception 'Part D: user_list_items missing'; end if;
  if to_regclass('public.letterboxd_import_jobs') is null then raise exception 'Part D: letterboxd_import_jobs missing'; end if;
  if to_regclass('public.letterboxd_sync_state') is null then raise exception 'Part D: letterboxd_sync_state missing'; end if;
  if to_regclass('public.letterboxd_follow_queue') is null then raise exception 'Part D: letterboxd_follow_queue missing'; end if;

  raise notice 'Part D: all invariants satisfied.';
end $$;
