-- Session 3 / Block 3: activate + feature 5 additional titles.
--
-- The user's brief listed 9 titles. The TMDb scrape (Phase A discover, popularity-ranked)
-- did not cover 4 of them:
--   * Stanleyville            (Oscilloscope, 2021) — not in catalog
--   * Our Day Will Come       (Oscilloscope) — not in catalog (also tried "Notre Jour Viendra")
--   * The Road Movie          (Oscilloscope) — not in catalog (only an unrelated 2002 Korean film matched)
--   * Mistress Dispeller      (Oscilloscope, 2024) — not in catalog
-- These would need a targeted TMDb /search/movie pull and an INSERT (out of scope tonight).
--
-- "November" had three candidates in the catalog (2004, 2017, 2022).
-- The Oscilloscope-distributed film is Rainer Sarnet's Estonian "November" (2017),
-- not the higher-popularity French "Novembre" / "November" (2022). Picking 2017.
--
-- "Obex" — only one match in catalog (year 2026, TMDb's coded release date for the
-- Albert Birney film). User memo said 2024; activating the 2026 row since it's
-- the only "Obex" post-2020.

update public.titles
  set is_active = true,
      is_featured = true,
      distributor = 'Oscilloscope Laboratories'
  where slug = 'november-2017';

update public.titles
  set is_active = true,
      is_featured = true,
      distributor = 'Oscilloscope Laboratories'
  where slug = 'obex-2026';

update public.titles
  set is_active = true,
      is_featured = true,
      distributor = 'Roadside Attractions'
  where slug = 'bob-trevino-likes-it-2025';

update public.titles
  set is_active = true,
      is_featured = true,
      distributor = 'Neon'
  where slug = 'splitsville-2025';

update public.titles
  set is_active = true,
      is_featured = true,
      distributor = 'Magnolia Pictures'
  where slug = 'it-s-never-over-jeff-buckley-2025';

-- Verification:
-- select slug, title, year, distributor, is_active, is_featured
--   from public.titles
--   where is_featured = true
--   order by
--     case distributor
--       when 'Oscilloscope Laboratories' then 1
--       when 'Magnolia Pictures' then 2
--       when 'Neon' then 3
--       when 'Roadside Attractions' then 4
--       else 5
--     end,
--     title;
-- Expect 7 rows: Erupcja + The Love Witch + 5 newly activated.
