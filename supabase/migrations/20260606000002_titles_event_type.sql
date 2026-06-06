-- Events content type (event-as-title, e.g. Sukeban match = one title).
-- Extends titles.media_type to allow 'event' alongside 'movie'/'tv', and
-- adds two nullable event-only columns (event_date, venue).
--
-- Additive + reversible.
--   * The CHECK swap triggers a one-time full-table revalidation scan
--     under a brief ACCESS EXCLUSIVE lock (~1.4M rows). All existing rows
--     are 'movie'/'tv' and pass; product is idle, so the lock is accepted.
--   * The two column adds are metadata-only: nullable with NO default, so
--     Postgres records the column in the catalog without rewriting the
--     table (no per-row work).
--   * No index, trigger (set_updated_at_titles / titles_person_names_sync),
--     generated column, or dependent view (admin_title_request_stats) is
--     affected by an ADD COLUMN.
--
-- Reverse:
--   ALTER TABLE public.titles DROP COLUMN IF EXISTS venue;
--   ALTER TABLE public.titles DROP COLUMN IF EXISTS event_date;
--   ALTER TABLE public.titles DROP CONSTRAINT IF EXISTS titles_media_type_check;
--   ALTER TABLE public.titles ADD CONSTRAINT titles_media_type_check
--     CHECK (media_type = ANY (ARRAY['movie'::text, 'tv'::text]));

ALTER TABLE public.titles DROP CONSTRAINT IF EXISTS titles_media_type_check;
ALTER TABLE public.titles ADD CONSTRAINT titles_media_type_check
  CHECK (media_type = ANY (ARRAY['movie'::text, 'tv'::text, 'event'::text]));

ALTER TABLE public.titles ADD COLUMN IF NOT EXISTS event_date timestamptz;
ALTER TABLE public.titles ADD COLUMN IF NOT EXISTS venue text;
