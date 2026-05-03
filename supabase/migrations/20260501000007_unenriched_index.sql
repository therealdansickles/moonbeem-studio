-- Resume gate index: lets fetch_unenriched_batch stream the next 200
-- un-enriched rows in tmdb_id order via an O(log n) index scan instead
-- of seq-scanning 1.4M titles every batch (which trips PostgREST's
-- ~60 s statement timeout once enriched_at IS NULL is the minority).
--
-- The partial predicate matches the script's WHERE clause exactly; the
-- planner can satisfy the query entirely from the index without touching
-- the heap (until it fetches the selected columns).
--
-- Plain CREATE INDEX (not CONCURRENTLY) because:
--   1. The CLI wraps migrations in a transaction; CONCURRENTLY can't run
--      inside one.
--   2. The scrape is paused, so the brief AccessShareLock conflict during
--      build is acceptable. With ~1.36M rows matching the predicate this
--      should complete in seconds.

create index if not exists titles_unenriched_tmdb_id_idx
  on public.titles(tmdb_id)
  where enriched_at is null and tmdb_id is not null;
