-- Link existing fan_edits to creators via stub creators — Stage 3.2.
--
-- Three parts:
--
-- PREFLIGHT: re-do the alexsorcist backfill that Stage 1's migration
-- silently no-op'd. The Stage 1 SQL targeted /reels/DXHbbZnCKTL/
-- (plural) but live URLs use /reel/ (singular) — re-import had
-- normalized them. Without this, the row stays @anon and we'd link
-- 54 fan_edits to stubs instead of 55.
--
-- FUNCTION find_or_create_stub_creator: idempotent (handle, platform)
-- → creator_id resolution. Reused by both this migration's DO loop
-- and the CSV importer (Stage 3.3). Logic:
--   1. If a creator_socials row already exists for (platform,
--      lower(handle)), return its creator_id (idempotency).
--   2. Otherwise allocate a free moonbeem_handle starting from the
--      raw handle, suffixing _2/_3/... if creators.moonbeem_handle
--      is taken. Per Option B (cross-platform same-handle = separate
--      stubs), this suffixes even when the conflicting row is
--      another stub — we don't merge stubs at link time.
--   3. INSERT the stub creator + INSERT the creator_socials row.
-- SECURITY DEFINER so the importer (running under service role) can
-- call it; auth.uid() is irrelevant here since stubs have no owner.
--
-- DO LOOP: iterates distinct (handle, platform) pairs across all
-- fan_edits with creator_id IS NULL and creator_handle_displayed
-- IS NOT NULL, in (platform asc, handle asc) order so the xcxshake
-- collision deterministically gives the instagram stub the bare
-- 'xcxshake' handle and the twitter stub 'xcxshake_2'. Updates all
-- matching fan_edits to the resolved creator_id.

update public.fan_edits
  set creator_handle_displayed = 'alexsorcist'
  where embed_url = 'https://www.instagram.com/reel/DXHbbZnCKTL/'
    and creator_handle_displayed is null;

create or replace function public.find_or_create_stub_creator(
  p_handle text,
  p_platform text
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_creator_id uuid;
  v_normalized text;
  v_moonbeem_handle text;
  v_suffix int := 1;
begin
  if p_handle is null then
    raise exception 'invalid_handle';
  end if;
  v_normalized := lower(trim(p_handle));
  if v_normalized = '' then
    raise exception 'invalid_handle';
  end if;

  select cs.creator_id into v_creator_id
    from public.creator_socials cs
    where cs.platform = p_platform
      and lower(cs.handle) = v_normalized
    limit 1;
  if v_creator_id is not null then
    return v_creator_id;
  end if;

  v_moonbeem_handle := v_normalized;
  while exists (
    select 1 from public.creators
    where lower(moonbeem_handle) = v_moonbeem_handle
  ) loop
    v_suffix := v_suffix + 1;
    v_moonbeem_handle := v_normalized || '_' || v_suffix;
  end loop;

  insert into public.creators (
    moonbeem_handle, user_id, is_claimed, is_stub, display_name
  ) values (
    v_moonbeem_handle, null, false, true, v_normalized
  ) returning id into v_creator_id;

  insert into public.creator_socials (creator_id, platform, handle)
    values (v_creator_id, p_platform, v_normalized);

  return v_creator_id;
end;
$$;

revoke execute on function public.find_or_create_stub_creator(text, text) from public;
grant execute on function public.find_or_create_stub_creator(text, text) to service_role;

do $$
declare
  pair record;
  v_creator_id uuid;
begin
  for pair in
    select distinct fe.creator_handle_displayed as handle, fe.platform
    from public.fan_edits fe
    where fe.creator_id is null
      and fe.creator_handle_displayed is not null
    order by fe.platform asc, fe.creator_handle_displayed asc
  loop
    v_creator_id := public.find_or_create_stub_creator(pair.handle, pair.platform);
    update public.fan_edits
      set creator_id = v_creator_id
      where creator_id is null
        and creator_handle_displayed = pair.handle
        and platform = pair.platform;
  end loop;
end;
$$;
