-- Delete 12 creator_earnings rows orphaned by the 4 fan_edit
-- duplicates soft-deleted in 20260509000006_fan_edits_post_id.
--
-- Background: pre-existing duplicate (title_id, post_id) pairs on
-- Erupcja meant earnings calc was crediting both rows of each pair
-- against the same TikTok aweme_id. Per-day calc already keys on
-- (creator_id, fan_edit_id, calculation_date) so two rows existed
-- per pair per day. Total over-credit on Erupcja: $87.84 (8784
-- cents) across 12 rows / 4 fan_edit_ids / 3 calculation dates
-- (2026-05-07, 2026-05-08, 2026-05-09).
--
-- Stripe production switchover hasn't happened (test keys per
-- followup queue), so no real money moved against any of these
-- rows. Hard-delete is safe; partner-dashboard read paths show
-- the corrected $876.22 (= 96406 - 8784) for 1-2-special the
-- moment the delete commits.
--
-- The 4 fan_edit_ids were captured from the keep/soft-delete
-- preview Dan approved before applying 20260509000006:
--   tiktok  7626450769692183830 → 0fe49ea8-af3e-42b1-b056-dd0e2e2bc1e3
--   tiktok  7627616681170324758 → 7cbc7796-e30c-4b62-a981-93b8c01a946f
--   twitter 2037213168209191391 → 9533c53b-88d5-4d68-8089-fd386f7f655a
--   twitter 2041980649725165780 → 78e6203b-a01b-4d4e-b329-55a64f255031
--
-- Defense-in-depth — the same commit also adds deleted_at IS NULL
-- filters to calculateEarningsForRate and the 4 partner-dashboard
-- read paths so this orphaning can't recur on future soft-deletes.
-- This DELETE just cleans the historical drift before partner
-- outreach week (2026-05-13).
--
-- Idempotent: re-running deletes 0 rows since the targets are
-- already gone after the first apply.

delete from public.creator_earnings
where fan_edit_id in (
  '0fe49ea8-af3e-42b1-b056-dd0e2e2bc1e3',
  '7cbc7796-e30c-4b62-a981-93b8c01a946f',
  '9533c53b-88d5-4d68-8089-fd386f7f655a',
  '78e6203b-a01b-4d4e-b329-55a64f255031'
);
