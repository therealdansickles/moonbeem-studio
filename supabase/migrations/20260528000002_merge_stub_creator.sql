-- Caller-driven claim of an orphan stub creator.
--
-- Background. Stub creators (is_stub=true, user_id IS NULL) are
-- minted by find_or_create_stub_creator (20260506000007) during
-- admin/CSV imports so attribution lands somewhere even when the
-- handle on the source URL doesn't match any real account yet.
-- mark_social_verified_and_merge (20260508000001 + 20260508000004)
-- folds a stub into a real user when verification finds an EXACT
-- (platform, lower(handle)) match between the verifying user and the
-- stub's creator_socials row.
--
-- The /me "Edits to claim" section surfaces a wider set of stubs via
-- getUnclaimedStubEditsForUser (src/lib/queries/profiles.ts:199-360),
-- which adds NORMALIZED-handle and platform-scoped verified-social
-- heuristics. For stubs surfaced by normalize-only matches, the
-- existing verification flow can't claim them — start_social_-
-- verification keys on EXACT (platform, lower(handle)), so a stub
-- with handle "duolingo_polska" never lines up with a user verifying
-- "duolingopolska". And once a user has any verified social on a
-- platform, VerifySocialsCard silently skips rendering for that
-- platform, so the "Verify to claim →" CTA dead-ends.
--
-- This RPC is the explicit one-click claim for those cases.
--
-- SECURITY. The caller passes a stub_creator_id and asks to claim it.
-- The auth gate has to mirror getUnclaimedStubEditsForUser EXACTLY,
-- because that query is the surfacing decision the UI uses to decide
-- which stubs to show a Claim button on. If the RPC accepts a match
-- that surfacing didn't, an authenticated user can claim a stub they
-- have no plausible tie to (security hole). If the RPC rejects a
-- match that surfacing accepted, the UI offers a button that errors
-- out (UX bug + erosion of trust). The two heuristics in step 3 below
-- are line-by-line equivalents of profiles.ts:282-310 — keep them in
-- lockstep with that file.
--
-- Merge body in step 4 mirrors mark_social_verified_and_merge
-- (20260508000001) and the creator_earnings move from
-- 20260508000004. The dup-skip pattern on creator_earnings is
-- preserved verbatim from the precedent.

-- Comparison-normalization for handles: lowercase + strip
-- underscores, dots, whitespace. Mirrors the JS normalize() at
-- profiles.ts:242 exactly. Used by both the security gate below and
-- (going forward, when we DRY profiles.ts onto this) the surfacing
-- query. If you change this function you MUST change the JS
-- normalize() the same way or the gate and the surface disagree.
create or replace function public.normalize_handle_for_match(h text)
returns text
language sql
immutable
as $$
  select regexp_replace(lower(coalesce(h, '')), '[_.[:space:]]', '', 'g');
$$;

revoke execute on function public.normalize_handle_for_match(text) from public;
grant execute on function public.normalize_handle_for_match(text) to authenticated;

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
  -- 1. Caller must be authenticated and own a live creator row. A
  --    user with no creator row hasn't been through claim_handle yet
  --    and has nothing to merge a stub into.
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

  -- 2. Target must be a live, unclaimed stub. FOR UPDATE serializes
  --    concurrent claim attempts on the same stub — last writer
  --    can't reanimate a row another transaction already merged and
  --    soft-deleted because the second SELECT FOR UPDATE blocks
  --    until the first commits, and then v_stub.id comes back NULL
  --    (deleted_at is set) and we raise stub_not_claimable.
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

  -- 3. THE SECURITY CHECK. Mirrors profiles.ts:282-310 exactly.
  --
  --    Heuristic (a) — user_handle: the stub has at least one
  --    creator_socials row on an allowed platform whose handle
  --    normalizes to the caller's moonbeem_handle. (profiles.ts:301
  --    `} else if (normH === normalizedUserHandle) {`.) The
  --    platform-in-allowed-list filter mirrors profiles.ts:284-288.
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

  --    Heuristic (b) — verified_social: the caller has a verified
  --    creator_socials row on platform P, and the stub has a
  --    creator_socials row on the same platform P where the two
  --    handles agree under lower() OR normalize_handle_for_match().
  --    (profiles.ts:294-300; the dual lower-OR-normalize check
  --    mirrors `platformVerified.exact.has(...) || platformVerified.
  --    normalized.has(normH)` exactly.) Platform scoping is
  --    load-bearing here — @dansickles on TikTok and @dansickles on
  --    Twitter could be different humans, and the surfacing query
  --    treats them as separate; the gate has to as well.
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

  -- 4. Merge body — mirrors mark_social_verified_and_merge body
  --    (20260508000001:170-182) + creator_earnings handling from
  --    20260508000004.

  update public.creator_socials
    set creator_id = v_user_creator_id
    where creator_id = p_stub_creator_id;

  update public.fan_edits
    set creator_id = v_user_creator_id
    where creator_id = p_stub_creator_id;

  -- creator_earnings: move to caller, flip claimed=true. Dup-skip
  -- preserves any pre-existing earnings row the caller already had
  -- for the same (fan_edit_id, calculation_date) — shouldn't happen
  -- for a never-claimed stub but the guard matches the precedent and
  -- is cheap.
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

  -- 5. Soft-delete the stub. Once deleted_at is set the stub no
  --    longer surfaces via getUnclaimedStubEditsForUser (its
  --    creators.deleted_at IS NULL filter, profiles.ts:267), so the
  --    "Edits to claim" entry vanishes on the next /me load.
  update public.creators
    set deleted_at = now()
    where id = p_stub_creator_id and deleted_at is null;
end;
$$;

revoke execute on function public.merge_stub_creator(uuid) from public;
grant execute on function public.merge_stub_creator(uuid) to authenticated;
