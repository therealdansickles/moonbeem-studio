-- Source Accounts v1 — account-first discovery pipeline.
--
-- Two net-new tables backing the "scrape a curator account -> match captions to
-- catalog -> human review -> confirm into fan_edits" flow (first target: the
-- Instagram account @docstowatch). Both are super-admin / service-role only:
-- RLS is enabled with NO policies (matching partner_payout_accounts et al.), so
-- anon/authenticated can never read them; every access goes through the
-- service-role client behind the admin route auth gate.
--
--   source_accounts       — one row per curator account we scrape.
--   source_account_posts  — the review queue: one row per scraped post, deduped
--                           by (source_account_id, shortcode). This UNIQUE is the
--                           dedup key from the recon: every incremental re-scrape
--                           re-returns the pinned posts + any overlap, and the
--                           queue upsert must ignore-on-conflict against it.

-- platform is an enum starting with 'instagram'; add 'tiktok' later via
-- `alter type source_account_platform add value 'tiktok'` (target #2).
create type source_account_platform as enum ('instagram');

-- Review lifecycle. 'no_match' = the matcher found nothing above the confidence
-- floor (distinct from 'rejected', which is a human decision).
create type source_account_post_status as enum (
  'pending', 'confirmed', 'rejected', 'no_match'
);

create table public.source_accounts (
  id uuid primary key default gen_random_uuid(),
  platform source_account_platform not null default 'instagram',
  handle text not null,
  -- The resolved platform user id (Instagram numeric pk). Nullable: a row can be
  -- seeded before the first resolve, and resolved lazily on first scrape.
  external_user_id text,
  last_scraped_at timestamptz,
  -- Incremental high-water mark: max(taken_at) over NON-pinned posts from the last
  -- scrape (unix seconds). Pinned posts are hoisted out of chronological order, so
  -- they must never advance this cursor. Fed to the next run's oldest_timestamp.
  cursor_max_taken_at bigint,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- One account row per (platform, handle). Handles are stored lowercased by the app.
create unique index source_accounts_platform_handle_unique
  on public.source_accounts (platform, handle);

create table public.source_account_posts (
  id uuid primary key default gen_random_uuid(),
  source_account_id uuid not null
    references public.source_accounts (id) on delete cascade,
  shortcode text not null,
  post_url text not null,
  caption text,
  -- Unix seconds (Instagram's taken_at_timestamp), kept raw for cursor math;
  -- converted to fan_edits.posted_at (timestamptz) at confirm time.
  taken_at bigint,
  is_pinned boolean not null default false,
  media_type text,
  video_view_count integer,
  like_count integer,
  -- Best catalog match (nullable until matched / when no match clears the floor).
  matched_title_id uuid references public.titles (id) on delete set null,
  match_confidence numeric,
  status source_account_post_status not null default 'pending',
  created_at timestamptz not null default now()
);

-- Dedup key (recon flag 3): the queue upsert targets this on conflict.
create unique index source_account_posts_account_shortcode_unique
  on public.source_account_posts (source_account_id, shortcode);

-- Review-surface reads: pending rows for an account, and a global pending list.
create index source_account_posts_account_status_idx
  on public.source_account_posts (source_account_id, status);
create index source_account_posts_pending_idx
  on public.source_account_posts (created_at)
  where status = 'pending';

-- Service-role only, no public access (mirrors partner_payout_accounts).
alter table public.source_accounts enable row level security;
alter table public.source_account_posts enable row level security;
