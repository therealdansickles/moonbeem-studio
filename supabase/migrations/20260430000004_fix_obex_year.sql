-- Obex is a 2025 release; TMDb's discover phase coded it as 2026.
-- Slug stays as 'obex-2026' (slug is based on the year at scrape time;
-- changing it would break any links already shared). Only the year field updates.

update public.titles
  set year = 2025
  where slug = 'obex-2026';
