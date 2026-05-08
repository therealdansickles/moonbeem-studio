-- Day 4: soft-delete column on fan_edits + RLS update.
--
-- Until now fan_edits had only an is_active boolean (toggled by the
-- view-tracking pipeline when a post is detected dead/private). v1
-- gave admins no first-class way to remove a row from public surfaces
-- without losing the audit of when it was hidden, so add deleted_at
-- (matches creators / partner_users / partner_title_rates pattern).
--
-- The public-read RLS policy is replaced to also exclude deleted_at
-- IS NOT NULL — soft-deleted rows disappear from anon/authenticated
-- reads immediately. Admin tooling reads via service-role, which
-- bypasses RLS, so it can still see deleted rows for audit/restore.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, DROP POLICY IF EXISTS.

alter table public.fan_edits
  add column if not exists deleted_at timestamptz;

create index if not exists idx_fan_edits_not_deleted
  on public.fan_edits (id) where deleted_at is null;

drop policy if exists "fan_edits are publicly readable when active and verified"
  on public.fan_edits;

create policy "fan_edits are publicly readable when active and verified"
  on public.fan_edits
  for select
  to anon, authenticated
  using (
    is_active = true
    and verification_status = 'auto_verified'
    and deleted_at is null
  );
