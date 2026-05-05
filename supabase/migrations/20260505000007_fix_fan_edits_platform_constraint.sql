-- Tracking-only migration: record the manual constraint fix applied
-- via direct SQL on 2026-05-05.
--
-- The original fan_edits_platform_check (from migration
-- 20260424000001_initial_schema.sql) listed 'x' as a valid platform.
-- We've since standardized on 'twitter' as the canonical value
-- (matches /admin/clicks rollup labels, the EnsembleData endpoint
-- naming, and avoids ambiguity with the X.com / Twitter rebrand).
--
-- The fix was applied directly in SQL Editor on 2026-05-05:
--   1. drop the old constraint
--   2. update the one existing row that had platform='x' to 'twitter'
--   3. add the corrected constraint
--
-- This file exists so the migration history table reflects what's
-- actually in the schema. Apply path:
--   supabase migration repair --status applied 20260505000007
-- (NOT supabase db push — production already has these statements
-- applied; re-running the alter would fail or no-op depending on
-- ordering.)
--
-- Statements are guarded with IF EXISTS / IF NOT EXISTS / WHERE
-- predicates so this file IS idempotent if anyone does run it
-- against a fresh environment that started without the constraint
-- in place.

alter table public.fan_edits
  drop constraint if exists fan_edits_platform_check;

update public.fan_edits
  set platform = 'twitter'
  where platform = 'x';

alter table public.fan_edits
  add constraint fan_edits_platform_check
  check (platform in ('tiktok', 'instagram', 'youtube', 'twitter'));
