-- Source Accounts — regrain the queue to row-per-(post, matched title).
--
-- Decision (2026-07-02): review is per-title and docstowatch's dominant format is
-- the listicle (one post lists ~10 films), so one post must be able to queue up
-- to N per-title matches, each independently confirm/reject-able. The post-level
-- fields stay in source_account_posts (rendered once in the review UI); the per-
-- title matches move to a child table. Tables are hours old and empty, so this is
-- a clean structural change, not a data migration.
--
-- Dedup grain moves to (source_account_post_id, matched_title_id) — equivalent to
-- UNIQUE (source_account_id, shortcode, matched_title_id) since a post row already
-- encodes (account, shortcode) via its own unique. Zero-match posts are
-- represented by a post row with matched_at set and NO match children, so a
-- re-scrape skips them (the matcher only runs on posts where matched_at IS NULL).

-- (1) Per-(post, title) matches.
create type source_account_match_status as enum ('pending', 'confirmed', 'rejected');

create table public.source_account_post_matches (
  id uuid primary key default gen_random_uuid(),
  source_account_post_id uuid not null
    references public.source_account_posts (id) on delete cascade,
  matched_title_id uuid not null references public.titles (id) on delete cascade,
  match_confidence numeric not null,
  status source_account_match_status not null default 'pending',
  -- Traceability + confirm idempotency: the fan_edit created when this match was
  -- confirmed (null until confirmed / if the insert was a dup).
  confirmed_fan_edit_id uuid references public.fan_edits (id) on delete set null,
  created_at timestamptz not null default now()
);

-- Per-title dedup within a post.
create unique index source_account_post_matches_post_title_unique
  on public.source_account_post_matches (source_account_post_id, matched_title_id);
create index source_account_post_matches_status_idx
  on public.source_account_post_matches (status);
create index source_account_post_matches_post_idx
  on public.source_account_post_matches (source_account_post_id);

alter table public.source_account_post_matches enable row level security;

-- (2) source_account_posts becomes purely post-level. Drop the status-dependent
--     indexes first, then the per-match columns, then add matched_at.
drop index if exists public.source_account_posts_pending_idx;
drop index if exists public.source_account_posts_account_status_idx;

alter table public.source_account_posts
  drop column matched_title_id,
  drop column match_confidence,
  drop column status,
  add column matched_at timestamptz;

-- Matcher work-queue: posts scraped but not yet matched.
create index source_account_posts_unmatched_idx
  on public.source_account_posts (created_at)
  where matched_at is null;

-- (3) The post-level status enum is now unused (status lives on matches).
drop type source_account_post_status;
