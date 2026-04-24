-- Initial schema for Moonbeem Studio bridge spec.
-- Enables RLS on every table; policies will be added per-feature.

-- =========================================================================
-- Extensions
-- =========================================================================

create extension if not exists "pgcrypto";

-- =========================================================================
-- Tables
-- =========================================================================

create table public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  display_name text,
  avatar_url text,
  is_admin boolean not null default false,
  created_at timestamptz not null default now(),
  last_active_at timestamptz
);

create table public.titles (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  title text not null,
  year integer,
  distributor text,
  poster_url text,
  synopsis text,
  runtime_min integer,
  director text,
  starring_csv text,
  external_watch_url text,
  theatrical_release_start timestamptz,
  theatrical_release_end timestamptz,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.title_offers (
  id uuid primary key default gen_random_uuid(),
  title_id uuid not null references public.titles(id) on delete cascade,
  offer_type text not null check (offer_type in ('theatrical', 'streaming', 'rent', 'buy')),
  provider text,
  provider_url text,
  provider_logo_url text,
  price_usd numeric,
  region_code text not null default 'US',
  last_refreshed_at timestamptz,
  is_active boolean not null default true
);

create table public.creators (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.users(id) on delete set null,
  moonbeem_handle text unique not null,
  display_name text,
  bio text,
  avatar_url text,
  is_claimed boolean not null default false,
  claim_code text,
  stripe_connect_id text,
  tip_jar_enabled boolean not null default false,
  tier text not null default 'open' check (tier in ('open', 'cleared')),
  total_tip_earnings_usd numeric not null default 0,
  total_affiliate_clicks integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.creator_socials (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.creators(id) on delete cascade,
  platform text not null check (platform in ('tiktok', 'instagram', 'youtube')),
  handle text,
  follower_count integer,
  last_refreshed_at timestamptz,
  is_verified boolean not null default false,
  verified_at timestamptz
);

create table public.creator_slate (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.creators(id) on delete cascade,
  title_id uuid not null references public.titles(id) on delete cascade,
  display_order integer,
  is_featured boolean not null default true,
  added_at timestamptz not null default now(),
  curator_note text,
  updated_at timestamptz not null default now()
);

create table public.clips (
  id uuid primary key default gen_random_uuid(),
  title_id uuid not null references public.titles(id) on delete cascade,
  file_url text,
  thumbnail_url text,
  duration_sec integer,
  scene_label text,
  access_tier_required text not null default 'open' check (access_tier_required in ('open', 'cleared')),
  download_count integer not null default 0,
  provenance_id text,
  created_at timestamptz not null default now()
);

create table public.stills (
  id uuid primary key default gen_random_uuid(),
  title_id uuid not null references public.titles(id) on delete cascade,
  file_url text,
  thumbnail_url text,
  caption text,
  access_tier_required text not null default 'open' check (access_tier_required in ('open', 'cleared')),
  download_count integer not null default 0,
  provenance_id text,
  created_at timestamptz not null default now()
);

create table public.fan_edits (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.creators(id) on delete cascade,
  title_id uuid not null references public.titles(id) on delete cascade,
  platform text not null check (platform in ('tiktok', 'instagram', 'youtube')),
  embed_url text,
  caption text,
  view_count integer not null default 0,
  like_count integer not null default 0,
  posted_at timestamptz,
  last_refreshed_at timestamptz,
  verification_status text not null default 'auto_verified' check (verification_status in ('auto_verified', 'needs_review')),
  perceptual_hash text,
  matched_clip_id uuid references public.clips(id) on delete set null,
  updated_at timestamptz not null default now()
);

create table public.affiliate_links (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.creators(id) on delete cascade,
  title_id uuid not null references public.titles(id) on delete cascade,
  slug text unique not null,
  destination_url text not null,
  click_count integer not null default 0,
  created_at timestamptz not null default now()
);

create table public.external_clicks (
  id uuid primary key default gen_random_uuid(),
  affiliate_link_id uuid references public.affiliate_links(id) on delete set null,
  title_offer_id uuid references public.title_offers(id) on delete set null,
  title_id uuid not null references public.titles(id) on delete cascade,
  clicked_at timestamptz not null default now(),
  referrer text,
  platform text,
  utm_medium text,
  city text,
  region_code text
);

create table public.tips (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.creators(id) on delete cascade,
  tipper_email text,
  amount_usd numeric not null,
  platform_fee_usd numeric,
  creator_payout_usd numeric,
  message text,
  fan_edit_id uuid references public.fan_edits(id) on delete set null,
  stripe_payment_intent_id text,
  status text not null default 'pending',
  created_at timestamptz not null default now()
);

create table public.view_tracking_snapshots (
  id uuid primary key default gen_random_uuid(),
  fan_edit_id uuid not null references public.fan_edits(id) on delete cascade,
  view_count integer,
  like_count integer,
  captured_at timestamptz not null default now()
);

create table public.claim_attempts (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.creators(id) on delete cascade,
  platform text,
  handle_submitted text,
  bio_code_issued text,
  status text not null default 'pending' check (status in ('pending', 'verified', 'expired')),
  issued_at timestamptz not null default now(),
  verified_at timestamptz,
  expires_at timestamptz
);

create table public.campaign_payouts (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.creators(id) on delete cascade,
  title_id uuid not null references public.titles(id) on delete cascade,
  campaign_label text,
  funding_source text not null default 'moonbeem_subsidy' check (funding_source in ('moonbeem_subsidy', 'distributor_paid')),
  amount_usd numeric,
  platform_fee_usd numeric,
  creator_payout_usd numeric,
  stripe_transfer_id text,
  status text not null default 'pending',
  notes text,
  paid_at timestamptz,
  created_at timestamptz not null default now()
);

-- =========================================================================
-- Indexes
-- =========================================================================

create index idx_creators_moonbeem_handle on public.creators (moonbeem_handle);
create index idx_titles_slug on public.titles (slug);
create index idx_fan_edits_creator_id on public.fan_edits (creator_id);
create index idx_fan_edits_title_id on public.fan_edits (title_id);
create index idx_creator_slate_creator_id on public.creator_slate (creator_id);
create index idx_affiliate_links_slug on public.affiliate_links (slug);

-- =========================================================================
-- Row Level Security (enable on all tables; policies added per-feature later)
-- =========================================================================

alter table public.users                    enable row level security;
alter table public.titles                   enable row level security;
alter table public.title_offers             enable row level security;
alter table public.creators                 enable row level security;
alter table public.creator_socials          enable row level security;
alter table public.creator_slate            enable row level security;
alter table public.clips                    enable row level security;
alter table public.stills                   enable row level security;
alter table public.fan_edits                enable row level security;
alter table public.affiliate_links          enable row level security;
alter table public.external_clicks          enable row level security;
alter table public.tips                     enable row level security;
alter table public.view_tracking_snapshots  enable row level security;
alter table public.claim_attempts           enable row level security;
alter table public.campaign_payouts         enable row level security;

-- =========================================================================
-- Trigger: auto-create profile row on signup
-- =========================================================================

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.users (id, email, display_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1))
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function public.handle_new_user();

-- =========================================================================
-- Trigger: maintain updated_at on mutable tables
-- =========================================================================

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger set_updated_at_titles
  before update on public.titles
  for each row
  execute function public.set_updated_at();

create trigger set_updated_at_creators
  before update on public.creators
  for each row
  execute function public.set_updated_at();

create trigger set_updated_at_creator_slate
  before update on public.creator_slate
  for each row
  execute function public.set_updated_at();

create trigger set_updated_at_fan_edits
  before update on public.fan_edits
  for each row
  execute function public.set_updated_at();
