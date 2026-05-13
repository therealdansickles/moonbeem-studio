-- Add featured_order column for super-admin curation of the homepage
-- Featured Films carousel. Today the carousel uses created_at ASC; this
-- migration backfills featured_order = 1..9 in that same order so the
-- live homepage shape is preserved on rollout. The /admin/featured page
-- (shipping in the same commit) is the first surface that mutates the
-- column.
--
-- Defaults & invariants:
--   - DEFAULT 0 keeps non-featured rows valid without a NULL state.
--   - When is_featured flips false→true elsewhere (PATCH endpoint),
--     featured_order is set to max(featured_order WHERE is_featured) + 1
--     to land the new entry at the end. The reorder POST handles
--     subsequent moves.
--   - When is_featured flips true→false, featured_order is left as-is.
--     Gap in the sequence is harmless — homepage filters WHERE
--     is_featured=true, so the inert value never participates in ORDER BY.
--   - The partial index covers the only query that uses this column —
--     the homepage Featured carousel — and stays small (9 rows today).
--
-- Mirrors clips.display_order / stills.display_order naming convention.

alter table public.titles
  add column if not exists featured_order integer not null default 0;

-- Backfill: sequence the currently-featured rows by created_at ASC,
-- which matches today's homepage rendering order. Idempotent — uses
-- WHERE featured_order = 0 to skip rows that have already been
-- backfilled (allows safe re-run if needed).
with ranked as (
  select id, row_number() over (order by created_at asc) as rn
  from public.titles
  where is_featured = true and featured_order = 0
)
update public.titles t
set featured_order = ranked.rn
from ranked
where t.id = ranked.id;

create index if not exists idx_titles_featured_order
  on public.titles (featured_order)
  where is_featured = true;
