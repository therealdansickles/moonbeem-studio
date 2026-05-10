-- Cleanup of 46 historical fan_edit_events authored by Moonbeem
-- internal admins (Dan + Rohan) between 2026-05-07 and 2026-05-10.
-- These events polluted the partner-visible "Moonbeem plays" count
-- on /p/[slug] before the track:false flag landed (this commit) on
-- the admin surfaces.
--
-- Pre-state (verified via scripts/audit-admin-pollution.mjs against
-- prod 2026-05-10):
--   modal_open: 24 events (Dan 22 + Rohan 2)
--   modal_close: 22 events (Dan 16 + Rohan 6)
--   By user_id: Dan 58fd3374-… → 38, Rohan 41d850cb-… → 8
--   Date range: 2026-05-07T19:32:14Z → 2026-05-10T20:05:53Z
--
-- Idempotent: WHERE clause guards on specific user_ids + event types.
-- Re-running deletes only what's still in the pollution set.
--
-- view_on_platform_click events not in scope (0 rows in prod for
-- those user_ids today; future admin clicks suppressed by the same
-- track:false flag).

delete from public.fan_edit_events
  where user_id in (
    '58fd3374-dba4-4dd6-bf42-fc102a5ba70a'::uuid,  -- Dan
    '41d850cb-95dc-447e-a67b-57516a410e05'::uuid   -- Rohan
  )
  and event_type in ('modal_open', 'modal_close', 'view_on_platform_click');
