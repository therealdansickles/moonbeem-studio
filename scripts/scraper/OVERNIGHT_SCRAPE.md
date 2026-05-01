# Overnight TMDb full-catalog scrape

End-to-end plan for replacing the popularity-filtered 86K catalog with
~1.4M TMDb titles (movies + TV) and enriching every row with full
cast + crew. Idempotent and resumable; running twice produces the same
end state.

## What runs

1. **Phase 1 — schema migrations**
   - `20260501000005_tv_support.sql` — `media_type`, `first_air_date`,
     `last_air_date`, `number_of_seasons`, `number_of_episodes`,
     `networks`, `production_companies`, `release_date`, `deleted`,
     plus a partial index on `(media_type, enriched_at) WHERE
     enriched_at IS NULL` for resumability scans.
   - `20260501000006_tmdb_id_media_unique.sql` — replaces the
     unique-on-`tmdb_id` index with `UNIQUE (tmdb_id, media_type)`
     (TMDb namespaces movie IDs separately from TV IDs).
2. **Phase 2 — discovery** (`discover_full_catalog.py`)
   - Downloads TMDb daily ID exports (movies + TV).
   - Filters out `adult=true` rows.
   - In-memory dedupes against existing `(tmdb_id, media_type)` keys
     fetched once at startup. Inserts stub rows for the rest, with
     placeholder `slug` (`tmdb-m-{id}` / `tmdb-t-{id}`) and
     placeholder `title` (`TMDB:{id}`); enrichment overwrites both.
   - Bulk-upserts via PostgREST with `on_conflict='slug'` and
     `ignore_duplicates=True`, so a re-run of discovery is a no-op.
3. **Phase 3 — enrichment** (`enrich_full_catalog.py`)
   - Loops `WHERE enriched_at IS NULL AND tmdb_id IS NOT NULL` in
     batches of `--batch-size` × `--parallel` rows.
   - Hits `/movie/{id}` or `/tv/{id}` with
     `?append_to_response=credits,external_ids[,release_dates|content_ratings]`.
   - **Bulk write path: direct asyncpg.** Single multi-row
     `INSERT ... ON CONFLICT (id) DO UPDATE SET …` per sub-batch.
     `--parallel` sub-batches run concurrently, each on its own
     pool connection. Strict allow-list in the `SET` clause; curated
     columns (`is_active`, `is_featured`, `distributor`, `slug` on
     non-stubs, `created_at`, `media_type`) are never updated.
   - Marker writes (404 → `deleted=true`; empty-data → just
     `enriched_at`) stay on PostgREST.
   - 35 rps via async + token bucket; 429 → exponential backoff up to
     3 retries; SIGINT/SIGTERM cleanly drains the in-flight batch
     and closes the pool + aiohttp session.
   - Per-iteration progress + ETA logged to console and to
     `logs/enrich_YYYYMMDD_HHMM.log`.

## Pre-flight checklist

- [ ] Supabase Pro plan with enough storage headroom (see "Storage
      projection" below — bumped to 32 GB tier).
- [ ] `scripts/scraper/.env` populated:
      `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `TMDB_API_KEY`,
      and **`DATABASE_URL`** (PostgreSQL URI from Supabase Dashboard →
      Project Settings → Database → Connection string).
- [ ] `DATABASE_URL` uses the **session pooler** (port `5432`) or
      **direct connection**, not the **transaction pooler**
      (port `6543`). The script auto-detects port 6543 / "pgbouncer"
      and disables prepared statements via `statement_cache_size=0`,
      which works but reduces throughput by ~30%. Override manually
      with `PG_STATEMENT_CACHE_SIZE=N` if needed.
- [ ] `scripts/scraper/.venv` exists with everything in
      `requirements.txt` (now includes `asyncpg` and `certifi`).
- [ ] iMac plugged in, sleep disabled with `caffeinate` (see Launch).
- [ ] Migrations applied:
      - `20260501000005_tv_support.sql`
      - `20260501000006_tmdb_id_media_unique.sql`
- [ ] Latest dry run reviewed and approved.
- [ ] Recent DB backup taken in Supabase dashboard.

## Launch

Run inside `tmux` so the session survives ssh disconnects, and wrap
in `caffeinate -i` so the iMac doesn't sleep during the scrape.

```bash
# 1. Start (or attach to) a tmux session
tmux new -s scrape    # or: tmux attach -t scrape

# 2. Inside tmux:
cd ~/moonbeem-studio/scripts/scraper
source .venv/bin/activate
mkdir -p logs

# Phase 2 — discovery (~5–10 min): bulk-inserts ~1.3M stubs.
STAMP=$(date +%Y%m%d_%H%M)
caffeinate -i python discover_full_catalog.py 2>&1 \
  | tee "logs/full_scrape_${STAMP}_discover.log"

# Phase 3 — enrichment (~18–28 h): asyncpg multi-row INSERTs.
STAMP=$(date +%Y%m%d_%H%M)
caffeinate -i python enrich_full_catalog.py 2>&1 \
  | tee "logs/full_scrape_${STAMP}.log"
```

Detach from tmux with `Ctrl-b d` to leave the scrape running.
Reattach later with `tmux attach -t scrape`.

The script also writes its own structured log to
`logs/enrich_YYYYMMDD_HHMM.log` independent of the `tee`'d console log.

## Monitoring

From the same machine:

```bash
tail -f ~/moonbeem-studio/scripts/scraper/logs/enrich_*.log
```

From phone over SSH (assuming home network reachability):

```bash
ssh user@home-imac "tail -f ~/moonbeem-studio/scripts/scraper/logs/enrich_*.log"
```

Each batch logs:

```
HH:MM:SS  INFO  [batch] enriched=98 deleted=1 failed=1 | total_done=12,345/1,400,000 (0.88%) | rate=34.2/s | ETA: 11h 18m
```

## Resume after a crash

Just re-run the same command (new dated log file is fine):

```bash
STAMP=$(date +%Y%m%d_%H%M)
caffeinate -i python enrich_full_catalog.py 2>&1 \
  | tee "logs/full_scrape_${STAMP}_resume.log"
```

The resume gate is the `enriched_at` watermark. Every batch fetched
by `fetch_unenriched_batch()` is filtered with:

```sql
WHERE enriched_at IS NULL AND tmdb_id IS NOT NULL
ORDER BY tmdb_id LIMIT N
```

Backed by the partial index `idx_titles_media_type_enriched ON
public.titles(media_type, enriched_at) WHERE enriched_at IS NULL`,
so the scan stays cheap as the un-enriched set shrinks.

A row gets `enriched_at` set on success **and** on 404
(`deleted=true`) **and** on empty-data marker — the only way to
re-process a row is to manually `UPDATE titles SET enriched_at = NULL
WHERE id = ?`. Verified by the idempotency test: re-running on
already-enriched rows produces byte-identical writes (only
`enriched_at` refreshes).

No `--resume` flag needed; resumability is structural.

## Expected runtime

The enrichment write path uses **direct asyncpg** connections (one
multi-row `INSERT ... ON CONFLICT (id) DO UPDATE` per sub-batch, with
`--parallel` sub-batches running concurrently). PostgREST is still
used for small ops (un-enriched-row reads, marker writes for 404s and
empty-data, count estimates).

Throughput measured on dry runs:

| `--batch-size` × `--parallel` | rate | notes |
|---|---|---|
| 50 × 1 | ~6/s | warmup-bound on small runs |
| 100 × 1 | ~14/s | one in-flight batch at a time |
| **100 × 2** (default) | **~14–22/s** | clean iters hit 22/s; collisions drop to ~10/s |
| 100 × 3 | similar | TMDb-rate-limit bound (35 rps total) |

Variability comes from **stub-slug collisions**: when a freshly
discovered stub's regenerated slug (`{title-slug}-{year}`) clashes
with an existing 86K row, we fall back to per-row writes with
`{title-slug}-tmdb-{id}` as the fallback. Each collision costs
~2 s vs ~50 ms for the bulk path. In production the existing 86K
rows take the fast non-stub path (their slug is already real) — only
the ~1.3M brand-new stubs from daily exports are at risk.

| Phase | Work | Time |
|---|---|---|
| Schema migrations | additive ALTER TABLE + indexes | < 1 min |
| Discovery | download daily exports, dedupe, bulk-insert ~1.3M stubs | ~5–10 min |
| Enrichment | 1.4M titles × 1 TMDb call, ~14–22 rows/s sustained | **~18–28 h** |
| Verification | spot-check SQL | ~1 min |

Total wall-clock: **~18–28 hours**, dominated by enrichment. Likely
fits in **one long overnight + a recovery session next day** if
something stops it mid-run. The script is fully resumable; just
re-run after a stop.

### Tuning

- `--batch-size` (default 100) — rows per sub-batch
- `--parallel` (default 2) — sub-batches running concurrently per
  outer iteration. Each sub-batch acquires its own pool connection;
  all share the global TMDb token bucket.
- `--rps` (default 35) — TMDb rate ceiling
- `PG_STATEMENT_CACHE_SIZE` env (auto: 100 for direct/session pooler,
  0 for transaction pooler / pgbouncer)

### Why these numbers

- **TMDb 35 rps is the real ceiling, not the database.** TMDb's
  documented limit is 50 rps; we run at 35 for headroom on bursts and
  to leave room for retries during 429 backoff. At 35 rps × 1 call
  per title, the theoretical floor for 1.4M rows is 1.4M / 35 ≈ 11 h,
  before any DB write cost. Our measured ~14–22 rps reflects DB write
  overlap with TMDb fetch — both happen concurrently at `--parallel
  2`, so wall-clock is `max(fetch_time, write_time)` not the sum.
- **asyncpg pool: `min_size=2, max_size=10`.** `--parallel 2` only
  needs 2 connections at any moment; `min=2` keeps two warm so each
  outer iteration acquires immediately. `max=10` is headroom for
  `--parallel 4–5` experiments without re-tuning. We never want
  pool-exhaustion stalls during a 28 h run.
- **`statement_cache_size`**: prepared statements give a measurable
  boost on direct/session-pooler connections; the transaction pooler
  forbids them, so we auto-disable based on URL hints.

## Disk monitoring (from your phone)

Quick row count via PostgREST (no SSH needed). Pipe through `jq` if you have it:

```bash
curl -s "$SUPABASE_URL/rest/v1/titles?select=count" \
  -H "Authorization: Bearer $SUPABASE_ANON_KEY" \
  -H "apikey: $SUPABASE_ANON_KEY" \
  -H "Prefer: count=estimated"
```

(Use `count=estimated` rather than `count=exact` — exact counts time out on this table size.)

For actual disk usage, the Supabase dashboard's "Database → Reports → Database size" panel updates every few minutes.

### When to scale the disk tier

- **Trigger**: `Database size > 25 GB at any point` during the scrape.
- **Action**: bump the disk tier in Supabase dashboard (no downtime; takes effect within minutes). The script keeps running.
- **Reasoning**: projected end state is ~17 GB, so 25 GB is a 50% headroom alarm. If you hit it, payload sizes are larger than the dry-run sample suggested (e.g., the popular head of the catalog has thicker cast/crew arrays), and the projection is off — scale before we hit a write-blocking out-of-disk.

A separate alarm: if database size *plateaus* while enriched-row count keeps climbing, that's a sign TOAST compression is keeping things slim — fine, no action.

## Saturday-morning verification

Run these against the prod DB once the scrape exits. They should
take seconds to a few minutes total.

```sql
-- 1. Coverage by media type — total / enriched / 404'd
select media_type,
       count(*) as total,
       count(*) filter (where enriched_at is not null) as enriched,
       count(*) filter (where deleted) as deleted_404
from public.titles
group by media_type
order by media_type;
-- Expect: movie ~1.15M, tv ~250K, both with enriched ≈ total - deleted_404.

-- 2. Manual-data preservation — the 7 active titles MUST be untouched.
--    enriched_at must match the values from yesterday's enrichment
--    (2026-05-01 ~15:43 UTC), NOT today's run timestamp.
select slug, title, year, is_active, is_featured, distributor, enriched_at
from public.titles
where is_active = true
order by slug;
-- Expect: same 7 rows, is_active=true, is_featured=true, distributor
-- preserved, enriched_at unchanged from 2026-05-01T15:43:*Z.
-- If ANY row's enriched_at is from today's run → bug. Stop and
-- investigate before promoting.

-- 3. Slug stability on the 7 — none should have flipped to a tmdb-* placeholder.
select slug from public.titles where is_active = true and slug like 'tmdb-%';
-- Expect: 0 rows.

-- 4. Sample 5 random enriched movies
select title, year, runtime_min,
       jsonb_array_length(cast_members) as cast_n,
       jsonb_array_length(crew) as crew_n,
       imdb_id
from public.titles
where media_type = 'movie' and enriched_at is not null and not deleted
order by random()
limit 5;

-- 5. Sample 5 random enriched TV series
select title, first_air_date, number_of_seasons, number_of_episodes,
       jsonb_array_length(cast_members) as cast_n,
       jsonb_array_length(crew) as crew_n,
       (select string_agg(n->>'name', ', ') from jsonb_array_elements(networks) as n) as networks
from public.titles
where media_type = 'tv' and enriched_at is not null and not deleted
order by random()
limit 5;

-- 6. Sanity: anyone who slipped past with no title?
select count(*) from public.titles
where enriched_at is not null and (title is null or title = '' or title like 'TMDB:%');
-- Expect: small number (rows where TMDb returned nothing useful and
-- looks_empty marked them — slug stays as tmdb-{m|t}-{id}, title stays
-- as the placeholder).

-- 7. How many un-enriched are still pending?
select media_type, count(*)
from public.titles
where enriched_at is null and tmdb_id is not null
group by media_type;
-- Expect: 0 if the scrape completed cleanly. Non-zero → resume.
```

If any check trips, **don't promote, don't trigger downstream
work** — investigate first. The asyncpg path is allow-listed but
manual data is non-recoverable if accidentally clobbered.

## Rollback

The migration is additive — everything new is `add column if not
exists` plus indexes. To roll back metadata writes (without losing
schema changes):

```sql
-- Reset the freshly-discovered stubs only. Be careful — this also
-- drops the cast/crew on rows enriched in this run.
update public.titles
set enriched_at = null,
    cast_members = null,
    crew = null
where slug like 'tmdb-m-%' or slug like 'tmdb-t-%';
```

Don't run the rollback against the 7 active titles or any row whose
slug doesn't start with `tmdb-`.

## Storage projection

See attached dry-run report — populated after running with `--limit`.
