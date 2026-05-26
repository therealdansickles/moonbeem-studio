-- Lateral order of homepage carousel sections. One row per
-- orderable section (marquee, featured, trending, recent, all-films).
-- The homepage reads display_order ASC and renders sections in that
-- order; slice-A/B/C's per-row pin/hide overrides continue to apply
-- INSIDE each section unchanged.
--
-- The 'moonbeem.' wordmark at the top of the page is a fixed header,
-- not a section here. Only the five carousels below it are reorderable.
--
-- Defaults & invariants:
--   - slug TEXT PRIMARY KEY — small, queryable, easier to inspect
--     than a uuid for an admin-facing config table with five known
--     rows.
--   - display_order INTEGER NOT NULL — ASC sort key. No UNIQUE on
--     display_order today; the reorder API does a two-phase write
--     (TEMP_OFFSET=10_000) so a future UNIQUE addition lands
--     collision-free.
--   - slug CHECK constraint locks the known taxonomy. A future
--     section addition (or rename) is a DROP-then-ADD constraint
--     change, matching the campaigns_v1_schema / campaign_funding
--     supersede precedent.
--   - Seeded in today's hardcoded JSX order. ON CONFLICT keeps the
--     migration idempotent on re-apply.
--   - No "is_visible" or hide column. Section-level visibility
--     (turning off an entire carousel) is out of slice D's scope.
--     If added later, an `is_visible boolean DEFAULT true` column
--     drops in without breaking the existing per-section pin/hide
--     story.
--   - RLS enabled, no policies. Service-role-only writes via the
--     admin reorder API; reads go through the service-role client
--     in the homepage page.tsx (matches partners / titles /
--     campaign-* read conventions).
--
-- Mirrors the column-naming family used by the per-row curation
-- migrations (20260512000007 featured, 20260512000008 marquee,
-- 20260526000001 recent, 20260526000002 allfilms, 20260526000003
-- trending) — a small table with display_order as the sort key
-- plus a CHECK that locks the taxonomy.

create table if not exists public.homepage_sections (
  slug text primary key,
  display_order integer not null,
  updated_at timestamptz not null default now()
);

alter table public.homepage_sections
  drop constraint if exists homepage_sections_slug_check;

alter table public.homepage_sections
  add constraint homepage_sections_slug_check
  check (slug in ('marquee', 'featured', 'trending', 'recent', 'all-films'));

insert into public.homepage_sections (slug, display_order) values
  ('marquee',    1),
  ('featured',   2),
  ('trending',   3),
  ('recent',     4),
  ('all-films',  5)
on conflict (slug) do nothing;

alter table public.homepage_sections enable row level security;
-- No policies. Service-role only.

drop trigger if exists set_updated_at_homepage_sections
  on public.homepage_sections;
create trigger set_updated_at_homepage_sections
  before update on public.homepage_sections
  for each row execute function public.set_updated_at();
