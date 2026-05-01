-- Session 4 / Tier 1: creator profile pages.
-- Adds user_top_titles (curated Top 12 list per user) and is_stub flag for
-- distinguishing unclaimed reserved handles from real users.

create table if not exists public.user_top_titles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  title_id uuid not null references public.titles(id) on delete cascade,
  position int not null check (position >= 1 and position <= 12),
  created_at timestamptz not null default now(),
  constraint user_top_titles_unique_user_position unique (user_id, position),
  constraint user_top_titles_unique_user_title unique (user_id, title_id)
);

create index if not exists idx_user_top_titles_user_id
  on public.user_top_titles(user_id);

alter table public.user_top_titles enable row level security;

create policy "Anyone can view user_top_titles"
  on public.user_top_titles for select
  using (true);

create policy "Users can insert their own user_top_titles"
  on public.user_top_titles for insert
  with check (auth.uid() = user_id);

create policy "Users can update their own user_top_titles"
  on public.user_top_titles for update
  using (auth.uid() = user_id);

create policy "Users can delete their own user_top_titles"
  on public.user_top_titles for delete
  using (auth.uid() = user_id);

comment on column public.users.links is
  'Array of {label, url} objects for link-in-bio style links';

alter table public.users
  add column if not exists is_stub boolean not null default false;
