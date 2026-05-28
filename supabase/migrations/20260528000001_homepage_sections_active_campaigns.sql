-- Extends homepage_sections.slug CHECK to include the creator-
-- facing "Active Fan Edit Campaigns" carousel, then inserts the row
-- positioned directly after Featured Films (display_order 3).
-- Existing trending/recent/all-films rows shift down by one
-- (3→4, 4→5, 5→6) to make room.
--
-- Original taxonomy + CHECK + seed lives in
-- 20260526000004_homepage_sections.sql. Per the "future section
-- addition (or rename) is a DROP-then-ADD constraint change"
-- precedent noted there, this migration follows that pattern.
--
-- Curation admin at /admin/homepage already exposes drag-to-
-- reorder via POST /api/admin/homepage/sections/reorder. The
-- reorder API UPDATEs by slug, so an admin drag won't insert
-- missing rows — this migration is required for the new section
-- to land in the DB at all. Once landed, Dan can relocate freely
-- from the curation UI.
--
-- Idempotent: the DO block runs the shift+insert only when no
-- active-campaigns row exists yet. A re-apply (or a downstream
-- environment where the row is already in place) is a no-op.

alter table public.homepage_sections
  drop constraint if exists homepage_sections_slug_check;

alter table public.homepage_sections
  add constraint homepage_sections_slug_check
  check (slug in (
    'marquee',
    'featured',
    'trending',
    'recent',
    'all-films',
    'active-campaigns'
  ));

do $$
begin
  if not exists (
    select 1 from public.homepage_sections where slug = 'active-campaigns'
  ) then
    update public.homepage_sections
      set display_order = display_order + 1
      where slug in ('trending', 'recent', 'all-films');

    insert into public.homepage_sections (slug, display_order)
      values ('active-campaigns', 3);
  end if;
end $$;
