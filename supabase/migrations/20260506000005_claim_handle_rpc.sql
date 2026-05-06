-- Atomic claim_handle RPC — Stage 2B.
--
-- Replaces the inline UPDATE users + INSERT creators sequence in
-- /api/users/handle/claim with a single transactional Postgres
-- function. Three branches:
--
--   1. No creators row for this handle → fresh INSERT (creators) +
--      UPDATE (users.handle).
--   2. Creators row exists with user_id IS NULL (stub from Stage 3
--      auto-import) → UPDATE creators SET user_id = caller, then
--      UPDATE users.handle. FOR UPDATE locks the stub row to prevent
--      two callers winning the same stub.
--   3. Creators row exists with user_id IS NOT NULL → raise
--      'handle_taken'.
--
-- Idempotency: a caller who already has users.handle = $1 (case-
-- insensitive) gets a no-op success. A caller who has a *different*
-- existing handle gets 'user_already_has_handle' — handle changes
-- need their own deliberate flow.
--
-- Defense in depth: format validation lives in the route, but the
-- RPC also rejects malformed handles in case a caller hits
-- supabase.rpc directly bypassing the route. Reserved-handle list
-- stays route-side (it's UX, not a data invariant).
--
-- SECURITY DEFINER so the function bypasses RLS; auth.uid() scopes
-- writes to the calling user's own rows. Any failure raises an
-- exception, which Postgres rolls back atomically — no partial
-- state where users.handle is set without a matching creators row.

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

  select id, user_id into v_creator_id, v_creator_user_id
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
