-- creator_socials: extend platform CHECK to include 'twitter' + add
-- UNIQUE (platform, lower(handle)) — Stage 3.1.
--
-- The original creator_socials CHECK (from 20260424000001_initial_schema)
-- listed only tiktok / instagram / youtube. Twitter was excluded
-- because the bridge spec didn't model X creators when the schema
-- was first written. Stage 3 backfills creator_socials from existing
-- fan_edits, including twitter rows (Erupcja has 21 twitter fan_edits),
-- so the constraint must allow it.
--
-- The UNIQUE index lets us safely use creator_socials as the
-- canonical (platform, handle) → creator_id index. Stage 3.2's
-- find_or_create_stub_creator function relies on this for
-- idempotency: re-running the function for the same (platform,
-- handle) returns the existing creator_id rather than creating a
-- duplicate stub. lower(handle) makes the index case-insensitive,
-- mirroring the moonbeem_handle convention. Partial WHERE clause
-- excludes rows with NULL handles (none today, defensive).
--
-- Idempotent via DROP/ADD CONSTRAINT IF EXISTS and IF NOT EXISTS on
-- the unique index. creator_socials currently has 0 rows, so the
-- UNIQUE add can't fail on existing data.
--
-- YouTube and Reddit deferred to followup per memory.

alter table public.creator_socials
  drop constraint if exists creator_socials_platform_check;

alter table public.creator_socials
  add constraint creator_socials_platform_check
  check (platform in ('tiktok', 'instagram', 'youtube', 'twitter'));

create unique index if not exists creator_socials_platform_handle_unique
  on public.creator_socials (platform, lower(handle))
  where handle is not null;
