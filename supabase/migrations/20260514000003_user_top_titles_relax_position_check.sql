-- Creator Onboarding v1 hotfix: relax the user_top_titles position
-- CHECK constraint so the two-phase reorder/remove shuffle works.
--
-- The reorder and remove endpoints (/api/profile/top-titles/*) bump
-- rows to temp positions (100 + i) mid-shuffle to dodge the
-- UNIQUE(user_id, position) constraint. The original
-- CHECK (position >= 1 AND position <= 12) rejected those temp
-- values with SQLSTATE 23514, breaking every drag-reorder and any
-- remove that left >= 1 other pick.
--
-- The <= 12 business rule is enforced at the API layer — add/route.ts
-- and reorder/route.ts both validate every position is 1..12 before
-- writing. Dropping the DB upper bound removes the redundant guard
-- that was actively breaking the shuffle. The UNIQUE(user_id,
-- position) constraint and the >= 1 lower bound both stay.

alter table public.user_top_titles
  drop constraint if exists user_top_titles_position_check;

alter table public.user_top_titles
  add constraint user_top_titles_position_check
  check (position >= 1);
