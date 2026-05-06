-- reserved_for_letterboxd_username column on creators — Stage 2A.2.
--
-- Used by the future Letterboxd-import claim flow (deferred to followup):
-- a stub creators row can hold the Letterboxd username it was inferred
-- from, so signup via "import my Letterboxd account" finds the stub
-- and claims it via case-insensitive handle match. v1 schema-readiness
-- only — no consumers in this stage.

alter table public.creators
  add column if not exists reserved_for_letterboxd_username text;

create index if not exists idx_creators_letterboxd_reservation
  on public.creators (lower(reserved_for_letterboxd_username))
  where reserved_for_letterboxd_username is not null;
