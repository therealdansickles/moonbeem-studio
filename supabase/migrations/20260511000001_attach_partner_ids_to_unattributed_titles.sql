-- Attach partner_id + flip is_public=true on three unattributed
-- titles that were already is_featured=true (and therefore visible
-- on the homepage Featured carousel via getFeaturedTitles, which
-- filters only on is_featured per the existing leak captured in
-- followup memory "is_public discovery-surface gating"). Anonymous
-- visitors clicking through were 404'ing at /t/[slug] because
-- canViewTitle blocks is_public=false rows for non-partner-team.
--
-- Pre-state (verified via service-role probe 2026-05-11):
--   November               (17c957e8-…) → partner_id NULL, is_public false
--   OBEX                   (a8a009f5-…) → partner_id NULL, is_public false
--   It's Never Over, Jeff Buckley (b3c0d3f3-…) → partner_id NULL, is_public false
--   All three: is_active=true, is_featured=true.
--
-- Confirmed partner intents:
--   November + OBEX  → Oscilloscope Laboratories
--                       (ffd7dd72-ffdd-46ce-9821-8afcfd620185)
--   Jeff Buckley     → Magnolia Pictures
--                       (08183510-da32-4fcd-8b36-b0c8b995bf4f)
--
-- Idempotent: WHERE guards on id + partner_id IS NULL. Replays are
-- a no-op once partner_id is set; the is_public update would still
-- re-set the value to true but that's a no-op when already true.

update public.titles
  set partner_id = 'ffd7dd72-ffdd-46ce-9821-8afcfd620185'::uuid,
      is_public  = true,
      updated_at = now()
  where id in (
    '17c957e8-413d-4453-9672-abc03d9f3f15'::uuid,
    'a8a009f5-ba61-4cb1-85c7-fc883e9b37c9'::uuid
  )
  and partner_id is null;

update public.titles
  set partner_id = '08183510-da32-4fcd-8b36-b0c8b995bf4f'::uuid,
      is_public  = true,
      updated_at = now()
  where id = 'b3c0d3f3-6bb0-4ead-a2ca-3c0a01ddd9f1'::uuid
  and partner_id is null;
