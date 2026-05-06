-- Normalize fan_edits.creator_handle_displayed to bare-handle form.
--
-- Two formats coexisted before this migration:
--   - Recent CSV imports stored bare handles ('xcxsource', 'filmupdatesmain').
--   - Two pre-CSV rows (TikTok + Twitter originals seeded April 28, then
--     populated by an oembed/EnsembleData refresh) stored '@'-prefixed
--     values ('@xcxsource', '@number.1.angel10').
--
-- Display layer adds the visual '@' at render time, so storage should
-- always be the bare lowercased handle. This migration also backfills
-- the IG reel DXHbbZnCKTL whose handle ('alexsorcist') was known but
-- never written to the row.
--
-- Idempotent: the @-strip filter no-ops on already-bare handles; the
-- alexsorcist backfill no-ops once the column is non-null.

update public.fan_edits
  set creator_handle_displayed = lower(substring(creator_handle_displayed from 2))
  where creator_handle_displayed like '@%';

update public.fan_edits
  set creator_handle_displayed = 'alexsorcist'
  where embed_url = 'https://www.instagram.com/reels/DXHbbZnCKTL/'
    and creator_handle_displayed is null;
