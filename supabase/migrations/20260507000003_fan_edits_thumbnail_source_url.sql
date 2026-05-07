-- Stage B2 follow-up: preserve the original CDN URL alongside the
-- R2-rehosted thumbnail.
--
-- view-tracking now fetches the upstream thumbnail (Instagram CDN,
-- TikTok CDN, Twitter CDN) and re-uploads it to our R2 bucket so we
-- own the asset and don't break on signed/expiring CDN URLs (notably
-- Instagram's fiev14 paths). thumbnail_url ends up pointing at R2;
-- thumbnail_source_url keeps the original for debugging and
-- re-processing.

alter table public.fan_edits
  add column if not exists thumbnail_source_url text;
