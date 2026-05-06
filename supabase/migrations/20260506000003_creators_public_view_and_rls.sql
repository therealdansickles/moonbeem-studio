-- Public view + insert RLS for creators — Stage 2A scaffolding.
--
-- public_creators view: exposes only the columns safe to read for
-- anyone (no claim_code, stripe_connect_id, financial counters).
-- Mirrors the public_profiles pattern from May 1. Views run with the
-- owner's privileges (security_invoker = false in PG 15+), so anon
-- and authenticated callers can SELECT through it without bypassing
-- creators RLS directly. WHERE deleted_at IS NULL gives us cheap
-- "active rows only" semantics at the view layer.
--
-- INSERT policy: handle/claim (today) and the Stage 2B auth state
-- machine need to create a creators row for the authenticated user.
-- Match the existing users self-update pattern: WITH CHECK ensures
-- the new row's user_id is the caller's auth.uid().

create or replace view public.public_creators as
  select
    id,
    user_id,
    moonbeem_handle,
    is_stub,
    is_claimed,
    profile_kind,
    created_at
  from public.creators
  where deleted_at is null;

grant select on public.public_creators to anon, authenticated;

drop policy if exists "Users can insert their own creator row"
  on public.creators;
create policy "Users can insert their own creator row"
  on public.creators for insert
  with check (auth.uid() = user_id);
