-- Stage 2C: bio-code verification flow for creator_socials.
--
-- Adds the columns needed to track an active verification attempt
-- (code + start time + method) plus the unique index on the active
-- code so collisions surface as DB errors rather than silent
-- ambiguity. Also adds two SECURITY DEFINER RPCs:
--
--   start_social_verification(platform, handle, code) — UPSERTs
--   the verification_code/started_at on the (platform, handle) row,
--   creating it on the user's creator if no row exists yet.
--   v1 race tradeoff: subsequent calls overwrite the previous
--   code (rare contention; documented in the API design).
--
--   mark_social_verified_and_merge(platform, handle) — atomic
--   transition to verified state. Validates active code +
--   24h-not-expired (the API has already matched the code against
--   the live bio before calling this). If the row was on a stub
--   creator, moves all of the stub's other socials and all
--   fan_edits to the caller's creator and soft-deletes the stub.
--
-- Both RPCs require the caller to be authenticated AND to already
-- have a non-deleted creator (claim_handle prerequisite). The
-- "auto-claim moonbeem_handle on first verification" flow is in
-- the followup queue — not v1.

alter table public.creator_socials
  add column if not exists verification_code text,
  add column if not exists verification_started_at timestamptz,
  add column if not exists verification_method text not null default 'bio_code';

create unique index if not exists creator_socials_verification_code_unique
  on public.creator_socials (verification_code)
  where verification_code is not null;

create or replace function public.start_social_verification(
  p_platform text,
  p_handle text,
  p_code text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_user_creator_id uuid;
  v_normalized text;
  v_existing_id uuid;
begin
  if v_user_id is null then
    raise exception 'not_authenticated';
  end if;
  if p_platform not in ('tiktok', 'instagram', 'twitter', 'youtube') then
    raise exception 'invalid_platform';
  end if;
  if p_code is null or p_code = '' then
    raise exception 'invalid_code';
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

  select id into v_existing_id
    from public.creator_socials
    where platform = p_platform
      and lower(handle) = v_normalized
    for update;

  if v_existing_id is not null then
    update public.creator_socials
      set verification_code = p_code,
          verification_started_at = now(),
          verification_method = 'bio_code'
      where id = v_existing_id;
  else
    insert into public.creator_socials (
      creator_id, platform, handle,
      verification_code, verification_started_at, verification_method,
      is_verified
    ) values (
      v_user_creator_id, p_platform, v_normalized,
      p_code, now(), 'bio_code',
      false
    );
  end if;
end;
$$;

revoke execute on function public.start_social_verification(text, text, text) from public;
grant execute on function public.start_social_verification(text, text, text) to authenticated;

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

  -- Mark verified + clear pending state. Reassign the row's
  -- creator_id to the user's creator (no-op when already there;
  -- handles the stub-merge case in one statement).
  update public.creator_socials
    set verified_at = now(),
        is_verified = true,
        verification_code = null,
        verification_started_at = null,
        creator_id = v_user_creator_id
    where id = v_social_row.id;

  -- If this row was previously on a stub creator, fold the stub
  -- entirely into the user's creator: any other socials on that
  -- stub move over, all fan_edits move over, then soft-delete.
  if v_old_creator_id is not null and v_old_creator_id <> v_user_creator_id then
    update public.creator_socials
      set creator_id = v_user_creator_id
      where creator_id = v_old_creator_id;

    update public.fan_edits
      set creator_id = v_user_creator_id
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
