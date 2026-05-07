-- Partner-level access control for /p/[slug].
--
-- v1: a partner_users table with (partner_id, user_id, role) and a
-- soft-delete column. The dashboard checks membership at page-load
-- time and 404s on miss — we don't reveal partner existence.
--
-- Per Dan's spec, the access check lives in the page (page-level
-- gating + service-role reads) rather than RLS on the underlying
-- data tables. RLS hardening of titles/fan_edits scoped by
-- partner_users is a v2 concern and would need careful handling so
-- /t/[slug] anon access keeps working.
--
-- role uses a CHECK constraint (not enum) for idempotent re-runs;
-- adding a third role later is just a constraint swap.

create table if not exists public.partner_users (
  id uuid primary key default gen_random_uuid(),
  partner_id uuid not null references public.partners(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'viewer',
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (partner_id, user_id)
);

alter table public.partner_users
  drop constraint if exists partner_users_role_check;

alter table public.partner_users
  add constraint partner_users_role_check
  check (role in ('admin', 'viewer'));

create index if not exists idx_partner_users_user_id
  on public.partner_users (user_id) where deleted_at is null;

create index if not exists idx_partner_users_partner_id
  on public.partner_users (partner_id) where deleted_at is null;

alter table public.partner_users enable row level security;
-- No policies. The /p/[slug] page reads via service-role to perform
-- the membership check, matching the convention used by
-- external_clicks/tips. Direct PostgREST access is denied.

-- Seed: Dan as admin for 1-2 Special. user_id captured from auth.users
-- on 2026-05-07. ON CONFLICT keeps the migration re-runnable.
insert into public.partner_users (partner_id, user_id, role)
  select id, '58fd3374-dba4-4dd6-bf42-fc102a5ba70a'::uuid, 'admin'
  from public.partners
  where slug = '1-2-special'
on conflict (partner_id, user_id) do nothing;
