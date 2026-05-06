-- Backfill creators from users — Stage 2A.1.
--
-- PRE-STAGE: repoint the stale dpop creators row (id=78409083...,
-- created May 5 during /go/ smoke testing) from dansickles' user
-- (58fd3374) to its rightful owner beec81a2 (the dpop user). Without
-- this, the Stage 2A.3 query refactor would resolve /c/dpop to the
-- wrong human after the swap to creators-first lookup. UPDATE rather
-- than DELETE+INSERT because affiliate_links has one row pointing at
-- creators.id=78409083 — repointing preserves that attribution.
--
-- ALTER: add is_stub column. Distinguishes CSV-auto-created stubs
-- (Stage 3) from human-claimed rows. Default false so backfilled rows
-- are non-stubs by default.
--
-- BACKFILL: insert one creators row per public.users row with a
-- non-null handle and is_stub=false. Existing rows (post-repoint) are
-- left alone via ON CONFLICT (moonbeem_handle) DO NOTHING. Stubby
-- users (users.is_stub=true) are excluded — the new architecture
-- moves the stub semantic to creators.user_id IS NULL, not users.
-- If any users.is_stub=true rows exist, they need a separate cleanup.
--
-- All three operations are idempotent; re-running the migration is safe.

update public.creators
  set user_id = 'beec81a2-d6d5-4de4-a0d4-31211b62431f',
      display_name = null,
      is_claimed = true
  where id = '78409083-2ff0-4c7e-aa4e-5abd76a38341';

alter table public.creators
  add column if not exists is_stub boolean not null default false;

insert into public.creators (
  user_id,
  moonbeem_handle,
  is_claimed,
  is_stub,
  created_at
)
select
  u.id,
  u.handle,
  true,
  false,
  u.created_at
from public.users u
where u.handle is not null
  and u.is_stub = false
on conflict (moonbeem_handle) do nothing;
