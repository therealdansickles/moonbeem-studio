-- Stage G: curated lists — editorial taste-curation surfaces.
--
-- curated_lists holds the list definitions (AFI Top 100, Greatest TV
-- Shows, and future Classic Favorites / Trending); curated_list_titles
-- maps catalog titles into a list at a position. These power the
-- discovery carousels on the /me/top-12 builder: a user can add any
-- of these titles to their own Top 12 as a taste signal, whether or
-- not the title is watchable on Moonbeem.
--
-- The schema is intentionally extensible — new lists slot in as new
-- curated_lists rows, and the future super-admin curation interface
-- writes against this same shape. Title rows are seeded separately
-- (migration 20260514000005) because the title_id mapping is resolved
-- by matching list entries against the catalog at build time.
--
-- RLS: public read of visible lists + their titles; super-admin write
-- (mirrors the clips/stills "Super admins can manage" pattern).

create table public.curated_lists (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  name text not null,
  description text,
  display_order int not null default 0,
  is_visible boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.curated_list_titles (
  id uuid primary key default gen_random_uuid(),
  curated_list_id uuid not null
    references public.curated_lists(id) on delete cascade,
  title_id uuid not null
    references public.titles(id) on delete cascade,
  position int not null,
  created_at timestamptz not null default now(),
  constraint curated_list_titles_unique_list_title
    unique (curated_list_id, title_id),
  constraint curated_list_titles_unique_list_position
    unique (curated_list_id, position)
);

create index idx_curated_list_titles_list
  on public.curated_list_titles (curated_list_id, position);

alter table public.curated_lists enable row level security;
alter table public.curated_list_titles enable row level security;

create policy "Public can view visible curated_lists"
  on public.curated_lists for select
  using (is_visible = true);

create policy "Super admins can manage curated_lists"
  on public.curated_lists for all
  using (
    exists (
      select 1 from public.users
      where users.id = auth.uid() and users.role = 'super_admin'
    )
  );

create policy "Public can view titles in visible curated_lists"
  on public.curated_list_titles for select
  using (
    exists (
      select 1 from public.curated_lists cl
      where cl.id = curated_list_titles.curated_list_id
        and cl.is_visible = true
    )
  );

create policy "Super admins can manage curated_list_titles"
  on public.curated_list_titles for all
  using (
    exists (
      select 1 from public.users
      where users.id = auth.uid() and users.role = 'super_admin'
    )
  );
