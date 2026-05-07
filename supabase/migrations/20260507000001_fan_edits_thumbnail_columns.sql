-- Stage B1: thumbnail-based architecture support.
-- Adds visual-metadata columns sourced from EnsembleData via the
-- view-tracking pipeline. thumbnail_url already exists (added in
-- 20260430000005_fan_edits_oembed.sql, populated by the oEmbed
-- pipeline at fan_edit ingest time). We add:
--   - duration_seconds: video length in whole seconds
--   - aspect_ratio:     simplified ratio string ("9:16", "16:9", etc.)
--                       used to render thumbnails without layout shift
--   - thumbnail_source: provenance tag so reads can reason about
--                       which pipeline produced the current thumbnail.
--                       Values: 'oembed' | 'ensembledata' | NULL.
-- Backfills thumbnail_source='oembed' for existing populated rows
-- (oEmbed was the only writer before this migration).

alter table public.fan_edits
  add column if not exists duration_seconds integer,
  add column if not exists aspect_ratio text,
  add column if not exists thumbnail_source text;

alter table public.fan_edits
  drop constraint if exists fan_edits_thumbnail_source_check;

alter table public.fan_edits
  add constraint fan_edits_thumbnail_source_check
  check (
    thumbnail_source is null
    or thumbnail_source in ('oembed', 'ensembledata')
  );

update public.fan_edits
  set thumbnail_source = 'oembed'
  where thumbnail_url is not null
    and thumbnail_source is null;
