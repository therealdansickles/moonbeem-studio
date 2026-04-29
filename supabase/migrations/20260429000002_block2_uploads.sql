-- Block 2: super_admin role, clips/stills metadata + display_order, public-read RLS.

alter table public.users
  add column if not exists role text not null default 'user';

alter table public.clips
  add column if not exists label text,
  add column if not exists file_size_bytes bigint,
  add column if not exists content_type text,
  add column if not exists duration_seconds numeric,
  add column if not exists thumbnail_url text,
  add column if not exists display_order integer not null default 0;

alter table public.stills
  add column if not exists alt_text text,
  add column if not exists photographer_credit text,
  add column if not exists width integer,
  add column if not exists height integer,
  add column if not exists file_size_bytes bigint,
  add column if not exists display_order integer not null default 0;

create index if not exists idx_clips_title_order
  on public.clips (title_id, display_order);

create index if not exists idx_stills_title_order
  on public.stills (title_id, display_order);

alter table public.clips enable row level security;
alter table public.stills enable row level security;

drop policy if exists "Public can view clips on active titles" on public.clips;
create policy "Public can view clips on active titles"
  on public.clips for select
  using (
    exists (
      select 1 from public.titles t
      where t.id = clips.title_id and t.is_active = true
    )
  );

drop policy if exists "Public can view stills on active titles" on public.stills;
create policy "Public can view stills on active titles"
  on public.stills for select
  using (
    exists (
      select 1 from public.titles t
      where t.id = stills.title_id and t.is_active = true
    )
  );

drop policy if exists "Super admins can manage clips" on public.clips;
create policy "Super admins can manage clips"
  on public.clips for all
  using (
    exists (
      select 1 from public.users
      where users.id = auth.uid() and users.role = 'super_admin'
    )
  );

drop policy if exists "Super admins can manage stills" on public.stills;
create policy "Super admins can manage stills"
  on public.stills for all
  using (
    exists (
      select 1 from public.users
      where users.id = auth.uid() and users.role = 'super_admin'
    )
  );
