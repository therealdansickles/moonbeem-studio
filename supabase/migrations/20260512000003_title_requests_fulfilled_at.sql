-- Schema-level fulfillment tracking on title_requests.
--
-- Previously, "is this request fulfilled?" was derived at display time by
-- LEFT JOINing fan_edits and checking visibility (is_active=true AND
-- verification_status='auto_verified' AND deleted_at IS NULL). That worked
-- but each surface re-implemented the filter, and the partner dashboard
-- showed inconsistent open-counts depending on which surface read it.
--
-- This migration adds an explicit fulfilled_at column. From here on, the
-- app-layer fulfillment hook in src/lib/title-requests/fulfill-on-fan-edit.ts
-- sets fulfilled_at = NOW() when a fan_edit publishes for a title with open
-- requests, and /api/titles/request auto-fulfills new requests if the title
-- already has published fan_edits. Display queries migrate to WHERE
-- fulfilled_at IS NULL.
--
-- Backfill below: any title_request whose title currently has at least one
-- visible fan_edit gets fulfilled_at = NOW(). No-notify on backfill — those
-- requesters were either already emailed (via clips/stills upload) or
-- never had a notification pipeline (fan_edit insert didn't notify before).

alter table public.title_requests
  add column if not exists fulfilled_at timestamptz null;

-- Partial index for the hot path. All three display surfaces filter
-- WHERE fulfilled_at IS NULL; a partial index skips the long tail of
-- fulfilled rows that will accumulate over time.
create index if not exists idx_title_requests_open
  on public.title_requests (title_id)
  where fulfilled_at is null;

update public.title_requests tr
set fulfilled_at = now()
where tr.fulfilled_at is null
  and exists (
    select 1 from public.fan_edits fe
    where fe.title_id = tr.title_id
      and fe.is_active = true
      and fe.verification_status = 'auto_verified'
      and fe.deleted_at is null
  );
