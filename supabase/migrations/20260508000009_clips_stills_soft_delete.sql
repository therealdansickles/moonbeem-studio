-- Day 4 (continued): soft-delete columns on clips + stills.
--
-- Mirrors the fan_edits.deleted_at pattern from
-- 20260508000006_fan_edits_soft_delete. The /admin/titles/[slug]
-- detail page's new Clips and Stills tabs need a way to remove a
-- bad row (e.g. a test upload that landed on the wrong title)
-- without losing audit history. Soft-delete via deleted_at fits the
-- convention used by creators / partner_users / partner_title_rates.
--
-- Public-read RLS for both tables already gates on titles.is_active;
-- we replace the policy to additionally exclude deleted_at IS NOT
-- NULL, so a soft-deleted clip/still drops out of /t/[slug] reads
-- immediately. The "Super admins can manage" policy stays unchanged
-- (admin must see soft-deleted rows for audit/restore).
--
-- Idempotent via ADD COLUMN IF NOT EXISTS, DROP POLICY IF EXISTS.

alter table public.clips
  add column if not exists deleted_at timestamptz;

alter table public.stills
  add column if not exists deleted_at timestamptz;

create index if not exists idx_clips_not_deleted
  on public.clips (id) where deleted_at is null;

create index if not exists idx_stills_not_deleted
  on public.stills (id) where deleted_at is null;

drop policy if exists "Public can view clips on active titles" on public.clips;
create policy "Public can view clips on active titles"
  on public.clips for select
  using (
    deleted_at is null
    and exists (
      select 1 from public.titles t
      where t.id = clips.title_id and t.is_active = true
    )
  );

drop policy if exists "Public can view stills on active titles" on public.stills;
create policy "Public can view stills on active titles"
  on public.stills for select
  using (
    deleted_at is null
    and exists (
      select 1 from public.titles t
      where t.id = stills.title_id and t.is_active = true
    )
  );
