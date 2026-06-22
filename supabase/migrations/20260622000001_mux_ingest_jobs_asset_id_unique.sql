-- Mux U2 (Part 2) — partial unique index on mux_ingest_jobs.mux_asset_id.
--
-- WHY: the storage-layer idempotency floor for the Mux webhook. video.upload.asset_created
-- is the FIRST writer of mux_asset_id (links upload -> asset). Mux delivers webhooks
-- at-least-once, so a redelivery (or two assets racing onto one job) must not create a
-- second claim. This partial unique guarantees one job per asset at the DB level; the
-- webhook catches the 23505 and treats it as a duplicate (no-op, returns 2xx).
--
-- Partial (WHERE mux_asset_id IS NOT NULL): the column is NULL for every job between
-- 'creating' and the asset_created event, and NULLs must stay non-unique (many in-flight
-- jobs coexist with NULL asset). Additive, non-destructive — no data rewrite.
--
-- Plain CREATE UNIQUE INDEX (not CONCURRENTLY): the migration runner wraps statements in a
-- transaction and CONCURRENTLY cannot run there. The table is tiny (async job rows), so a
-- brief lock is immaterial.

create unique index if not exists mux_ingest_jobs_mux_asset_id_key
  on public.mux_ingest_jobs (mux_asset_id)
  where mux_asset_id is not null;
