-- Creator Onboarding v1: track dismissal of the first-sign-in
-- welcome banner on /me.
--
-- The welcome banner shows for first-time users (zero verified
-- socials AND zero Top 12 picks AND no prior dismissal). It hides
-- permanently once the user takes a first onboarding action (picks
-- a film, starts verification) or explicitly closes it — both write
-- now() into this column.
--
-- Nullable, default NULL. Idempotent via ADD COLUMN IF NOT EXISTS.

alter table public.users
  add column if not exists onboarding_banner_dismissed_at timestamptz;
