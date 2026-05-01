-- Public profile view: exposes only the columns safe to read for anyone
-- (no email or private fields). Underlying public.users keeps its row-level
-- security; this view runs with the view owner's privileges (the default
-- security_invoker = false in Postgres 15+), so anon/authenticated callers
-- can SELECT through it without bypassing RLS on the base table directly.

create or replace view public.public_profiles as
  select
    id,
    handle,
    display_name,
    bio,
    avatar_url,
    links,
    is_stub
  from public.users;

grant select on public.public_profiles to anon, authenticated;
