-- Stage H: rename the "Greatest TV Shows of All Time" curated list
-- to "Top Rated Series" (name + slug). The carousel heading on
-- /me/top-12 renders from curated_lists.name, so this rename
-- propagates to the UI with no code change. The slug change keeps
-- the URL/query identifier in step with the new name.
--
-- No-op on a fresh DB that already seeded under the new slug.

update public.curated_lists
  set name = 'Top Rated Series',
      slug = 'top-rated-series',
      updated_at = now()
  where slug = 'greatest-tv-shows';
