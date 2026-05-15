-- Block 3: user fan-edit URL-paste submission flow needs three new
-- verification_status values + two new columns.
--
-- Status state machine:
--   'auto_verified' — legacy admin imports (kept as alias for 'approved')
--   'needs_review'  — legacy unused, retained for back-compat
--   'pending'       — user submitted, awaiting admin review
--   'approved'      — admin approved a user submission (publicly readable)
--   'rejected'      — admin rejected a user submission (with reason)
--
-- 'auto_verified' and 'approved' both indicate "publicly readable" —
-- the public RLS policy now permits either. Long-term we may migrate
-- existing 'auto_verified' rows to 'approved' for a single canonical
-- value; banking that as a followup since it touches ~265 rows.

-- 1. Drop and re-add the CHECK constraint with the three new values.
alter table public.fan_edits
  drop constraint if exists fan_edits_verification_status_check;

alter table public.fan_edits
  add constraint fan_edits_verification_status_check
  check (
    verification_status in (
      'auto_verified',
      'needs_review',
      'pending',
      'approved',
      'rejected'
    )
  );

-- 2. rejection_reason: free-text explanation surfaced on the
-- submitter's /me + included in the rejection email. NULL on
-- everything except rejected rows. Length cap enforced at the API
-- layer (500 chars).
alter table public.fan_edits
  add column if not exists rejection_reason text;

-- 3. created_by_user_id: who submitted. NULL for legacy admin imports
-- (we never tracked the originating admin); populated for every user
-- submission going forward. ON DELETE SET NULL so removing a user
-- doesn't cascade-delete their published fan_edits.
alter table public.fan_edits
  add column if not exists created_by_user_id uuid
    references public.users(id) on delete set null;

create index if not exists idx_fan_edits_created_by_user_id
  on public.fan_edits (created_by_user_id)
  where created_by_user_id is not null;

-- 4. Public RLS policy: extend to include 'approved' so user-
-- submitted-then-approved edits are publicly readable on /c/[handle]
-- and /t/[slug]. 'auto_verified' continues to work for legacy admin
-- imports. 'pending' and 'rejected' rows remain RLS-blocked from
-- anon/authenticated reads — only the submitter's /me sees them
-- (via service-role) and the admin queue (via service-role).
drop policy if exists "fan_edits are publicly readable when active and verified"
  on public.fan_edits;

create policy "fan_edits are publicly readable when active and verified"
  on public.fan_edits
  for select
  to anon, authenticated
  using (
    is_active = true
    and verification_status in ('auto_verified', 'approved')
    and deleted_at is null
  );
