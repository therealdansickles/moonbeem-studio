-- Day 4: title activation lifecycle for partner-attached titles.
--
-- Two booleans on titles:
--   is_active — admin-flippable. Drives whether a title is in the
--     operational pipeline (CPM rates apply, partner dashboard
--     surfaces it, view-tracking refreshes its fan edits, public
--     /t/[slug] is allowed).
--   is_public — admin-flippable but only meaningful when
--     is_active=true. Controls whether anonymous /t/[slug] returns
--     the title page or 404s. A title can be Active+!Public so the
--     partner can see it on their dashboard while the public surface
--     stays gated (soft-launch / preview state).
--
-- Default false on both: the catalog has ~1.4M scraped titles, and
-- it would be wrong to promote any of them implicitly. Erupcja is
-- explicitly seeded active+public below to preserve current
-- behavior.
--
-- Index on (is_active, is_public) where is_active=true keeps the
-- "active partnered titles" picker fast as the active set grows.
--
-- Anti-pattern guard: we do NOT enable RLS-driven public gating on
-- /t/[slug] in this migration. The page-level check happens in
-- /t/[slug] code. Reason: /t/[slug] today is unauthenticated, RLS
-- on titles is permissive, and changing that touches a much larger
-- surface than this single toggle. v2 follow-up.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, single UPDATE, conditional.

alter table public.titles
  add column if not exists is_active boolean not null default false,
  add column if not exists is_public boolean not null default false;

create index if not exists idx_titles_active_public
  on public.titles (is_active, is_public)
  where is_active = true;

-- Seed Erupcja: it's the only partner-attached title today and
-- already shipping on /t/erupcja, so preserve the current state.
update public.titles
  set is_active = true,
      is_public = true
  where slug = 'erupcja';
