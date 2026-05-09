-- Service-role helpers for the partner-members admin UI on /admin.
--
-- find_auth_user_by_email: look up auth.users.id for an exact
-- (lower-cased, trimmed) email match. Returns NULL when there's no
-- account for that email. The "invite member" form uses this to
-- confirm the target already signed in via Google OAuth before
-- inserting a partner_users row. Real invite-with-email-link flow
-- (creating accounts on first invite) is a followup.
--
-- list_partner_members: return active partner_users joined to
-- auth.users.email for one partner, used by ManageMembersModal's
-- initial fetch. Single round trip + the join lives in Postgres
-- rather than N getUserById calls from JS.
--
-- Both are SECURITY DEFINER (they read auth.users which is not
-- accessible to anon/authenticated by default). EXECUTE is revoked
-- from public; service_role bypasses GRANT checks, and the API
-- route handlers already gate super_admin before invoking. Not
-- granted to authenticated to avoid email enumeration via the RPC.

create or replace function public.find_auth_user_by_email(p_email text)
returns uuid
language plpgsql
stable
security definer
set search_path = public, auth
as $$
declare
  v_id uuid;
  v_email text := lower(trim(p_email));
begin
  if v_email = '' then return null; end if;
  select id into v_id from auth.users
    where lower(email) = v_email
    limit 1;
  return v_id;
end;
$$;

revoke execute on function public.find_auth_user_by_email(text) from public;

create or replace function public.list_partner_members(p_partner_id uuid)
returns table(
  id uuid,
  user_id uuid,
  email text,
  role text,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public, auth
as $$
begin
  return query
  select pu.id, pu.user_id, u.email::text, pu.role, pu.created_at
  from public.partner_users pu
  join auth.users u on u.id = pu.user_id
  where pu.partner_id = p_partner_id
    and pu.deleted_at is null
  order by pu.created_at asc;
end;
$$;

revoke execute on function public.list_partner_members(uuid) from public;
