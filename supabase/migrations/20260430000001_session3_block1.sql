-- Session 3 / Block 1: relax titles read-RLS (catalog-wide public viewability),
-- activate The Love Witch, add is_featured, create title_requests.

-- Relax public-read on titles: every row in catalog should be publicly viewable.
-- Inactive rows still render with empty content tabs and a "Request fan edits" CTA.
drop policy if exists "titles are publicly readable when active" on public.titles;
drop policy if exists "titles are publicly readable" on public.titles;
create policy "titles are publicly readable"
  on public.titles
  for select
  to anon, authenticated
  using (true);

-- Activate The Love Witch (Oscilloscope, slug includes year per TMDb scraper convention).
update public.titles
  set is_active = true,
      distributor = 'Oscilloscope Laboratories'
  where slug = 'the-love-witch-2016';

-- Featured flag drives the home page carousel.
alter table public.titles
  add column if not exists is_featured boolean not null default false;

update public.titles
  set is_featured = true
  where slug in ('erupcja', 'the-love-witch-2016');

-- title_requests captures public "Request fan edits" clicks.
create table if not exists public.title_requests (
  id uuid primary key default gen_random_uuid(),
  title_id uuid not null references public.titles(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  requested_at timestamptz not null default now(),
  user_agent text,
  constraint title_requests_unique_per_user unique (title_id, user_id)
);

create index if not exists idx_title_requests_title_id
  on public.title_requests(title_id);

alter table public.title_requests enable row level security;

drop policy if exists "Anyone can request a title for fan edits" on public.title_requests;
create policy "Anyone can request a title for fan edits"
  on public.title_requests for insert
  to anon, authenticated
  with check (true);

drop policy if exists "Super admins can read all title requests" on public.title_requests;
create policy "Super admins can read all title requests"
  on public.title_requests for select
  using (
    exists (
      select 1 from public.users
      where users.id = auth.uid() and users.role = 'super_admin'
    )
  );
