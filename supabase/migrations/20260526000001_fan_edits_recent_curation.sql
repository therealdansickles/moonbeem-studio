-- Add per-fan_edit columns for super-admin curation of the homepage
-- Recent Edits carousel. Today the carousel uses created_at DESC; this
-- migration leaves all rows with no curation overrides on rollout
-- (recent_pin_order NULL on every row, is_hidden_from_recent FALSE).
-- The /admin/recent-edits page (shipping in the same commit) is the
-- first surface that mutates these columns.
--
-- Defaults & invariants:
--   - recent_pin_order INTEGER NULL — pinned position; NULL = not
--     pinned; smaller numbers = higher pin position. The homepage
--     query renders pinned rows first (ORDER BY recent_pin_order ASC
--     NULLS LAST), then the remaining slots fill from created_at DESC.
--   - is_hidden_from_recent BOOLEAN NOT NULL DEFAULT FALSE — excludes
--     a fan_edit from the Recent Edits carousel ONLY. Per-carousel
--     hide, not a global hide: All Films / Featured / Trending each
--     get their own hide flag in future slices so the same edit can
--     be hidden from one surface without being hidden from another.
--   - No index. The homepage selects a top-12 set; the pinned subset
--     stays tiny in practice (1-5 rows). If pinned-set size grows past
--     ~50, a partial index on (recent_pin_order) WHERE recent_pin_order
--     IS NOT NULL would speed the ORDER BY; not warranted yet.
--   - Per-carousel naming follows the established Featured precedent
--     (titles.featured_order). The "recent_" prefix leaves room for
--     parallel allfilms_pin_order and trending_pin_order in Slices A
--     and C without column-name collisions.
--
-- Mirrors 20260512000007 (titles_featured_order) but on fan_edits and
-- with both a pin-order column AND a hide flag — Recent supports
-- "hide-but-leave-on-the-platform"; Featured was binary (is_featured
-- on/off) and didn't need a separate hide.

alter table public.fan_edits
  add column if not exists recent_pin_order integer,
  add column if not exists is_hidden_from_recent boolean not null default false;
