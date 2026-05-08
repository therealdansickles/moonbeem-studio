-- Day 4: per-platform visibility toggle for verified socials on the
-- public /c/[handle] profile.
--
-- Adds creator_socials.display_on_profile (default true) so a verified
-- handle is shown in the new "verified socials" section by default.
-- Owners can toggle per-platform via /me/edit. Unverified rows
-- (is_verified=false / verified_at IS NULL) are never shown
-- regardless of this column — the public render also filters on
-- is_verified=true.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS.

alter table public.creator_socials
  add column if not exists display_on_profile boolean not null default true;
