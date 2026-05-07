-- Partner accounts for the /p/[slug] dashboard.
--
-- Multi-tenant from day one (URL structure /p/[slug] supports it),
-- though v1 has only 1-2 Special and the dashboard is public-but-
-- obscure (no auth gate). When a second partner onboards we'll add
-- RLS scoping; the data model is already partitioned by partner_id.
--
-- titles.partner_id is the FK that scopes a partner's data — fan
-- edits, snapshots, modal events, ticket clicks all join through
-- titles. ON DELETE SET NULL: deleting a partner shouldn't cascade
-- to their titles (we want to keep the catalog), just orphan the
-- partner_id pointer.

create table if not exists public.partners (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  logo_url text,
  created_at timestamptz not null default now()
);

alter table public.titles
  add column if not exists partner_id uuid
    references public.partners(id) on delete set null;

create index if not exists idx_titles_partner_id
  on public.titles (partner_id) where partner_id is not null;

-- Seed: 1-2 Special as the first partner; link Erupcja to it.
insert into public.partners (slug, name)
  values ('1-2-special', '1-2 Special')
  on conflict (slug) do nothing;

update public.titles
  set partner_id = (select id from public.partners where slug = '1-2-special')
  where slug = 'erupcja' and partner_id is null;

alter table public.partners enable row level security;
-- No policies yet. The /p/[slug] dashboard reads via service role on
-- the server (matches external_clicks/tips convention). When auth
-- gating arrives, we add a policy keyed off some claim or membership.
