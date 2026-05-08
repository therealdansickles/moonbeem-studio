-- pg_trgm GIN index on titles.title to make admin catalog search
-- (`ilike '%query%'`) usable across the ~1.4M-row catalog.
--
-- Without the index, the partner-attribution modal's debounced
-- search hits a parallel seq scan + filter (~26s on real data,
-- exceeds the PostgREST statement timeout). With the index, ILIKE
-- with leading wildcards becomes an index-supported lookup —
-- typical sub-50ms.
--
-- pg_trgm is already installed on this project (verified
-- 2026-05-09). The index is GIN over `gin_trgm_ops` so all three
-- LIKE forms are supported (prefix, contains, suffix). Idempotent
-- via IF NOT EXISTS.

create index if not exists idx_titles_title_trgm
  on public.titles using gin (title gin_trgm_ops);
