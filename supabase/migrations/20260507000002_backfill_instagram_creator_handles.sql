-- One-time backfill: populate fan_edits.creator_handle_displayed for
-- Instagram rows where it's currently null, using data.owner.username
-- from the most recent view_tracking_snapshots row.
--
-- Context: B1 added the EnsembleData visual-metadata extraction but
-- did not extract data.owner.username on first pass. The patch in
-- ensemble.ts + upsert.ts (deployed alongside this migration) handles
-- new rows and future refreshes; this migration retroactively fills
-- in rows that already have a snapshot but no displayed handle.
--
-- Idempotent: WHERE clause skips already-populated rows.

update public.fan_edits fe
set creator_handle_displayed = subq.username
from (
  select distinct on (s.fan_edit_id)
    s.fan_edit_id,
    s.raw_payload -> 'data' -> 'owner' ->> 'username' as username
  from public.view_tracking_snapshots s
  where s.raw_payload -> 'data' -> 'owner' ->> 'username' is not null
  order by s.fan_edit_id, s.captured_at desc
) subq
where fe.id = subq.fan_edit_id
  and fe.platform = 'instagram'
  and fe.creator_handle_displayed is null
  and subq.username is not null;
