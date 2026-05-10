-- Link 3 IG fan_edits to creators + hard-delete 1 test orphan.
--
-- Pre-state (verified via scripts/audit-anon-ig-handles.mjs against
-- production 2026-05-10):
--
--   fan_edits with creator_id IS NULL and creator_handle_displayed
--   set on Erupcja (cada3be6-…):
--     - DXCyMjykUjN @ emilyndowner (IG, 1442 views)
--     - DV2c-xJDDGc @ allie.xcx     (IG, 10861 views)
--     - DW80wG4B-S3 @ shawnsh4rp    (IG, 335 views)
--
--   Plus a test-debris row left over from yesterday's unique-
--   constraint validation: id=83e5df0f-c2c6-48c5-be76-16d43108c2d7,
--   embed_url='https://example.com/duplicate-test', view_count=0.
--   No FK references (view_tracking_snapshots, creator_earnings,
--   fan_edit_events all 0).
--
-- Why these 3 weren't caught by the 2026-05-06 backfill in
-- migration 20260506000007: their creator_handle_displayed was NULL
-- at backfill time and got patched (manual UPDATE) later. The
-- backfill DO-loop only ran once, no trigger re-runs it on
-- subsequent NULL→non-NULL transitions. See followup memory
-- "Backfill protection trigger" for the long-term fix.
--
-- Approach:
-- 1. emilyndowner OVERRIDE (Option B exception): the TikTok
--    @emilyndowner creator (id 7ec780bf-…) is the SAME PERSON as
--    the IG @emilyndowner whose post we're linking. Manually
--    verified via Instagram.com visit. Standard Option B would
--    create a separate IG stub; this migration overrides because
--    we have direct cross-platform identity evidence — the merge
--    signal Option B was waiting for, delivered manually instead
--    of via UX claim flow.
-- 2. allie.xcx + shawnsh4rp: standard find_or_create_stub_creator
--    path. Neither has any prior creator/creator_socials presence,
--    so this creates fresh IG stubs.
-- 3. Hard-delete test debris.
--
-- Idempotency: each step uses NOT EXISTS / IS NULL guards so a
-- replay of this migration is a no-op. find_or_create_stub_creator
-- itself is already idempotent on (platform, lower(handle)).

-- =====================================================================
-- 1. emilyndowner: attach IG creator_socials to existing TikTok creator
-- =====================================================================

insert into public.creator_socials (creator_id, platform, handle)
select
  '7ec780bf-b6cb-46a9-b93c-e2ed907248b8'::uuid,
  'instagram',
  'emilyndowner'
where not exists (
  select 1 from public.creator_socials
  where platform = 'instagram'
    and lower(handle) = 'emilyndowner'
);

update public.fan_edits
  set creator_id = '7ec780bf-b6cb-46a9-b93c-e2ed907248b8'::uuid
  where post_id = 'DXCyMjykUjN'
    and platform = 'instagram'
    and creator_id is null;

-- =====================================================================
-- 2. allie.xcx + shawnsh4rp: standard stub-creator path
-- =====================================================================

do $$
declare
  v_creator_id uuid;
  pair record;
begin
  for pair in
    select * from (values
      ('DV2c-xJDDGc', 'allie.xcx'),
      ('DW80wG4B-S3', 'shawnsh4rp')
    ) as t(post_id, handle)
  loop
    v_creator_id := public.find_or_create_stub_creator(pair.handle, 'instagram');
    update public.fan_edits
      set creator_id = v_creator_id
      where post_id = pair.post_id
        and platform = 'instagram'
        and creator_id is null;
  end loop;
end;
$$;

-- =====================================================================
-- 3. Hard-delete test debris from 2026-05-10 unique-constraint testing
-- =====================================================================

delete from public.fan_edits
  where id = '83e5df0f-c2c6-48c5-be76-16d43108c2d7'::uuid
    and embed_url = 'https://example.com/duplicate-test';
