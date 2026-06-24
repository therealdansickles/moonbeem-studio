-- Per-title territory rights for Mux playback (Unit 3a).
--
-- Two columns on titles + a load-bearing worldwide backfill of existing public
-- titles. Enforcement lives in src/lib/playback/territory.ts isTerritoryAllowed()
-- (default-deny on unset); the playback-token route is unchanged.
--
--   allowed_territories : ISO 3166-1 alpha-2 ALLOW-list. NULLABLE, NO DEFAULT —
--       a legacy row is NULL = "unset", NOT an empty array. Default-deny on unset
--       lives in the helper, never as a column constraint (a NOT NULL /
--       default-'{}' column would silently deny every one of the 1.43M legacy
--       rows). Codes are stored uppercase alpha-2 to match x-vercel-ip-country.
--   territory_worldwide : explicit "licensed everywhere" flag, DISTINCT from
--       unset. NOT NULL DEFAULT false. (Adding a NOT NULL column with a CONSTANT
--       default is a metadata-only change in PG11+ — no table rewrite on titles.)
--
-- BACKFILL (the anti-regression step): mark every currently-public title
-- worldwide, preserving its global availability as an EXPLICIT declaration.
-- Without this, the helper's new default-deny would make all 23 public titles
-- (Watch Hill, Erupcja, …) stop playing. Only is_public titles are viewer-
-- reachable publicly, and the pre-migration census found 0 non-public titles with
-- a published episode, so scoping the backfill to is_public misses nothing
-- viewable. The `territory_worldwide = false` guard makes the UPDATE idempotent.

alter table public.titles
  add column if not exists allowed_territories text[],
  add column if not exists territory_worldwide boolean not null default false;

update public.titles
   set territory_worldwide = true
 where is_public = true
   and territory_worldwide = false;
