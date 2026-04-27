-- Bring fan_edits to v9 spec.
-- Original schema: 20260424000001_initial_schema.sql

-- Make creator_id nullable so fan edits can be seeded before creators exist.
-- Will tighten back to NOT NULL in a future migration once all edits are creator-linked.
alter table public.fan_edits
  alter column creator_id drop not null;

-- Make embed_url required.
alter table public.fan_edits
  alter column embed_url set not null;

-- Drop and recreate the platform check to allow 'x' (Twitter/X).
alter table public.fan_edits
  drop constraint if exists fan_edits_platform_check;
alter table public.fan_edits
  add constraint fan_edits_platform_check
  check (platform in ('tiktok', 'instagram', 'youtube', 'x'));

-- Add columns introduced in v9.
alter table public.fan_edits
  add column if not exists creator_handle_displayed text;
alter table public.fan_edits
  add column if not exists display_order integer not null default 0;
alter table public.fan_edits
  add column if not exists is_active boolean not null default true;
alter table public.fan_edits
  add column if not exists created_at timestamptz not null default now();

-- Index for the title page query (title_id + is_active + display_order).
create index if not exists idx_fan_edits_title_active_order
  on public.fan_edits (title_id, is_active, display_order);

-- Public-read policy: anon + authenticated, only active and auto-verified rows.
-- Review-pending edits stay invisible until manually approved.
create policy "fan_edits are publicly readable when active and verified"
  on public.fan_edits
  for select
  to anon, authenticated
  using (is_active = true and verification_status = 'auto_verified');
