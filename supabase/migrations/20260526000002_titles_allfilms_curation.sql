-- Add per-title columns for super-admin curation of the homepage
-- All Films carousel. Today the carousel uses created_at DESC; this
-- migration leaves all rows with no curation overrides on rollout
-- (allfilms_pin_order NULL on every row, is_hidden_from_all_films
-- FALSE). The /admin/all-films page (shipping in the same commit) is
-- the first surface that mutates these columns.
--
-- Defaults & invariants:
--   - allfilms_pin_order INTEGER NULL — pinned position; NULL = not
--     pinned; smaller numbers = higher pin position. The homepage
--     query renders pinned rows first (ORDER BY allfilms_pin_order
--     ASC NULLS LAST), then the remaining rows fill from created_at
--     DESC. All Films is an "everything" list (no LIMIT) so pinning
--     just promotes a small set to the top, never excludes anything.
--   - is_hidden_from_all_films BOOLEAN NOT NULL DEFAULT FALSE —
--     excludes a title from the All Films carousel ONLY. Per-carousel
--     hide, not a global hide: a featured title can be hidden from
--     All Films but stay on Featured, matching the comment in
--     getAllFilms that "Featured titles intentionally appear in BOTH
--     Featured and All Films."
--   - No index. titles.media_type='movie' is ~11 rows today; pinned
--     subset stays tiny.
--   - Parallel-but-distinct from is_featured + featured_order
--     (20260512000007). A title can be in BOTH Featured and All Films
--     with INDEPENDENT pin orders and hide flags in each — the two
--     carousels are separate editorial surfaces.
--   - Per-carousel naming follows the Recent precedent
--     (fan_edits.recent_pin_order from 20260526000001). The
--     "allfilms_" prefix leaves room for parallel trending_pin_order
--     in Slice C without column-name collisions.
--
-- Mirrors 20260526000001 (fan_edits_recent_curation) but on titles.

alter table public.titles
  add column if not exists allfilms_pin_order integer,
  add column if not exists is_hidden_from_all_films boolean not null default false;
