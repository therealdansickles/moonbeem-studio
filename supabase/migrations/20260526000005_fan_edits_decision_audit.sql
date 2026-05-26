-- Audit columns for fan_edit decisions (approve / reject). Records
-- WHO made the decision and WHEN, regardless of which path produced
-- the decision (today: super-admin /api/admin/fan-edits/[id]/approve
-- + /reject; new: partner-admin /api/p/[slug]/fan-edits/[id]/decide).
-- Same column flips across all three routes — single audit trail.
--
-- Defaults & invariants:
--   - decided_by_user_id UUID NULL — FK to auth.users with ON DELETE
--     SET NULL. NULL means either "decision predates this audit
--     layer" (every approved/rejected row currently in production)
--     or "the deciding user has since been deleted from auth.users."
--     The auth.users.id reference is consistent with how
--     created_by_user_id is wired on other tables (campaigns,
--     campaign_funding, partner_users).
--   - decided_at TIMESTAMPTZ NULL — populated by the deciding route
--     via new Date().toISOString() at write time. NULL means "row
--     is still in a pre-decision state (auto_verified / needs_review
--     / pending) OR was decided before this audit layer existed."
--   - NO BACKFILL. Every approved or rejected fan_edit in production
--     today predates this audit layer by definition; the columns
--     stay NULL on those rows. The historical decided-by/at info
--     was never captured anywhere else, so backfill isn't possible
--     short of educated-guess inference from row created_at /
--     created_by, which would create more confusion than truth.
--   - No index in v1. Audit lookups are operator-rare; queries
--     filter by primary keys or status enums first. If we ever need
--     "who decided most recently" admin reports, a (decided_at DESC)
--     index can be added then.
--
-- Related:
--   - rejection_reason TEXT NULL (existing, added pre-this-layer) —
--     populated on reject paths when a reason is supplied. The
--     partner reject path takes an OPTIONAL reason; the super-admin
--     reject path REQUIRES a reason (it's the input the creator
--     notification email renders).

alter table public.fan_edits
  add column if not exists decided_by_user_id uuid references auth.users(id) on delete set null,
  add column if not exists decided_at timestamptz;
