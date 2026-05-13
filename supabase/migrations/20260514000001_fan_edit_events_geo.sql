-- Geo capture for fan_edit_events + delete-by-user cascade.
--
-- Three nullable geo columns (country_code, region_code, city) populated
-- by /api/analytics/modal-event from Vercel's x-vercel-ip-* headers,
-- gated on the visitor's analytics consent cookie. Anon-no-decision
-- visitors get NULLs (event still recorded for engagement metrics; no
-- geo persisted). EU/UK/CH opt-in regions default to consent=false,
-- so their geo stays NULL until explicit acceptance.
--
-- City-level precision only — no lat/lng. country_code is ISO-3166-1
-- alpha-2 ("US", "DE"). region_code is the Vercel subdivision code
-- (e.g., "CA" for California, "ENG" for England). city is the city
-- name as returned by Vercel (URL-decoded server-side).
--
-- FK change: user_id now ON DELETE CASCADE (was ON DELETE SET NULL).
-- When a user deletes their account, their event rows are removed
-- cleanly. Compliance over reproducibility — accepted tradeoff per
-- the 2026-05-14 product decision. Anonymous rows (user_id IS NULL)
-- are unaffected since CASCADE only fires on referenced-row deletion.

alter table public.fan_edit_events
  add column if not exists country_code text,
  add column if not exists region_code text,
  add column if not exists city text;

-- Swap user_id FK semantics SET NULL → CASCADE.
alter table public.fan_edit_events
  drop constraint if exists fan_edit_events_user_id_fkey;
alter table public.fan_edit_events
  add constraint fan_edit_events_user_id_fkey
  foreign key (user_id) references public.users(id) on delete cascade;

-- Aggregation index for the admin geo widget. Partial WHERE
-- country_code IS NOT NULL keeps the index small (excludes the
-- larger anonymous + opted-out tail) while supporting the top
-- queries: GROUP BY country_code per fan_edit_id over a time window.
create index if not exists idx_fan_edit_events_geo
  on public.fan_edit_events (fan_edit_id, country_code, created_at desc)
  where country_code is not null;
