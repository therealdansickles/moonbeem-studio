# Block D — Catalog Freshness via Supabase Scheduled Function

## Architecture decision

Pure ETL job. No LLM in the runtime path. Runs in Supabase as a `pg_cron`-triggered Edge Function so it sits next to the database, has no separate infra to babysit, and survives the iMac being asleep, traveling, or rebooted.

`pg_cron` runs SQL on a schedule. That SQL uses `pg_net` to POST to the Edge Function URL. Both extensions must be enabled.

Rejected alternatives:
- **launchd on iMac** — fails when the machine sleeps or you travel with the laptop. Catalog goes stale silently.
- **$5/mo cloud VM** — works, but adds a server to monitor and pay for. Overkill for a daily job.
- **GitHub Actions cron** — works, but introduces another deploy surface and requires storing Supabase service role key as an Action secret.

## What the function does (v1 — changes-feed only)

1. Pulls TMDb's `/movie/changes` and `/tv/changes` feeds for the prior 24 hours. Paginates through all pages of each.
2. For each ID in the changes feeds: fetch full details from TMDb, upsert into `titles` keyed on `(tmdb_id, media_type)`. Inline enrichment — no stub-then-enrich split. Insert vs. update is implicit in the upsert (`on conflict (tmdb_id, media_type) do update`).
3. Upsert preserves `is_active`, `is_featured`, `slug`, `distributor`, `created_at` via an explicit column allowlist.
4. Writes a row to `catalog_sync_runs` with timestamps, counts, status, and resume token.

**Why no daily ID-export ingestion in v1:** the prior overnight TMDb scrape gives us 1.4M titles at 99.998% enriched coverage, so we already have the historical bulk. New titles surface in `/changes` when they're created or first edited. The ID-export-diff approach (gzipped 1M+ line file, read-and-diff every day) is heavy and mostly redundant given existing coverage. Simpler function = fewer failure modes. **Known gap:** titles created and never edited never appear in `/changes`. If that gap turns out to matter in practice, a separate weekly export-sweep function is the follow-up — not v1.

**Re-fetch policy:** every ID in `/changes` gets re-fetched, no filtering. TMDb publishes thousands of new IDs/day across movies + TV; quality varies widely; we don't filter by quality at ingest. Volume per single day's changes feed is bounded (typically a few hundred to a few thousand). Re-fetching is idempotent. If this becomes a hotspot later, add a `last_synced_at` column and skip-if-recent guard.

**TMDb rate limit:** 35 req/s is OUR conservative self-throttle (carried over from prior scrape behavior), not TMDb's published limit. TMDb soft-enforces ~50 req/s per IP. We stay well under to leave headroom for any other concurrent traffic on the same IP.

## Chunking and checkpointing

Supabase Edge Function wall clock is **150 s on Free, 400 s on Paid** (per current docs; no configurable extension flag). Function reads `MAX_RUNTIME_SECONDS` from env (default `120`) and computes a budget = 80% of that. Conservative free-tier-safe default; override the secret to `400` if/when the project tier is confirmed Paid. Function must exit cleanly before its budget and resume on next invocation rather than running to completion in one shot.

Resume state lives in `catalog_sync_runs.cutoff_token` (jsonb):

```json
{
  "current_feed": "movie",
  "current_page": 7,
  "current_page_last_id_processed": 12345,
  "feeds_completed": ["movie"]
}
```

When `feeds_completed.length === 2` (both `movie` and `tv` drained), the run ends with `status='success'`.

Pattern:
1. Write `catalog_sync_runs` row with `status='running'` and `started_at` at top of function.
2. Track elapsed time. At 80% of timeout budget, stop processing new IDs.
3. Write current cursor position to `cutoff_token` (e.g. last processed `tmdb_id` in changes feed, or page number).
4. Update row with `status='partial'` and exit.
5. Next invocation reads most recent `partial` run and resumes from `cutoff_token` before pulling fresh changes feed.
6. Once all work for the day is done, mark `status='success'`.

For typical days (a few hundred to a few thousand changes), the whole job finishes in one invocation. Chunking exists for outlier days (TMDb bulk re-tags, network slowness, rate-limit backoff).

## Success criteria

- Function runs daily at 06:00 UTC (01:00 ET — before US morning traffic).
- `catalog_sync_runs` shows a `success` row every 24h (or a chain of `partial` rows ending in `success`).
- TMDb rate limit (35/sec) is respected — function self-throttles.
- Zero impact on `is_active`, `is_featured`, `slug`, `distributor`, `created_at` for existing rows.
- New titles appear in `titles` with full metadata, not stubs.

## Failure modes and rollback

- **TMDb 5xx or rate limit (429)** — function backs off, logs the cutoff, exits with `status='partial'`. Next run resumes.
- **TMDb 401 (auth failure)** — function exits immediately with `status='failed'` and explicit error. Do not silently write zero-counts rows.
- **Schema drift** — if TMDb adds a field we don't have a column for, function ignores it (explicit column allowlist on upsert).
- **Edge Function timeout** — function is designed to chunk work and exit cleanly via the checkpoint pattern. Next run picks up.
- **Rollback** — disable the cron schedule via `cron.unschedule('catalog-freshness-daily')`. No data rollback needed; reads are non-destructive on existing rows.

## Tripwires (stop and ask Dan)

- More than 1000 changed titles in a single run (suggests TMDb did a bulk update or our changes feed query is wrong)
- Any `is_active=true` row about to be modified — log and skip, never touch active titles without human review
- New `media_type` value we haven't seen before
- TMDb returns 401 on the API key (auth failure — possible key rotation needed)
- `catalog_sync_runs` shows three consecutive failures (or a `partial` chain that never reaches `success` after 3 invocations)

## Schema: `catalog_sync_runs`

```sql
create table public.catalog_sync_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  status text not null check (status in ('running', 'success', 'partial', 'failed')),
  new_titles_count int not null default 0,
  changed_titles_count int not null default 0,
  failed_titles_count int not null default 0,
  tmdb_changes_pages_fetched int not null default 0,
  cutoff_token jsonb,
  error_message text,
  created_at timestamptz not null default now()
);

create index catalog_sync_runs_started_at_desc on public.catalog_sync_runs (started_at desc);
create index catalog_sync_runs_status on public.catalog_sync_runs (status) where status in ('running', 'partial');
```

`cutoff_token` is `jsonb` so the function can store whatever resume state makes sense (page number, last processed ID, both).

The partial index on `status` lets the resume logic find in-flight runs cheaply without scanning the whole history.

## Known followups (v1 limitations)

- Spot-check existing 1.4M corpus for `adult=true` titles that may have slipped through prior discovery (TMDb flag flips, earlier seed scripts).
- Confirm `/api/search`, `/browse`, `/c/[handle]` suppress adult titles defensively even when present in `titles`.
- Retroactive flag flips: catalog-freshness today filters adult on insert/update from `/changes`, but doesn't re-check existing rows whose TMDb adult flag flipped post-ingest. Acceptable for v1 given volume; revisit if needed.

## Files to create

```
supabase/functions/catalog-freshness/index.ts        # main function entry
supabase/functions/catalog-freshness/tmdb.ts         # TMDb client with rate limit + 401 detection (changes feed + details only)
supabase/functions/catalog-freshness/upsert.ts       # upsert logic with column allowlist
supabase/functions/catalog-freshness/checkpoint.ts   # resume/checkpoint logic
supabase/migrations/20260505000001_catalog_sync_runs.sql           # run history table (saved 2026-05-05, unapplied)
supabase/migrations/<timestamp>_schedule_catalog_freshness.sql     # pg_cron schedule (apply LAST, after manual invoke verifies)
```

## Environment variables required

- `TMDB_API_KEY` (already in Vercel; needs to be added to Supabase Edge Function secrets)
- `SUPABASE_SERVICE_ROLE_KEY` (auto-injected in Edge Functions)
- `SUPABASE_URL` (auto-injected)

## Deployment steps

0. Verify `pg_cron` and `pg_net` extensions are enabled in Supabase dashboard (Database → Extensions). Enable if not.
1. Write functions and migrations on local branch.
2. `npm run build` — confirm no type errors in the surrounding Next.js codebase.
3. Apply `catalog_sync_runs` migration to prod (no staging exists). Confirm with Dan first.
4. Deploy function: `supabase functions deploy catalog-freshness --no-verify-jwt`.
5. Set secret: `supabase secrets set TMDB_API_KEY=<value>`.
6. Manually invoke once: `supabase functions invoke catalog-freshness`. Inspect logs.
7. Verify `catalog_sync_runs` has a `status='success'` row. Spot-check 5 changed titles in `titles` table — confirm metadata refreshed AND `is_active`, `is_featured`, `slug`, `distributor`, `created_at` unchanged on rows that had values set.
8. Apply pg_cron schedule migration to enable daily 06:00 UTC run.
9. Wait 24h. Confirm second `success` row appears in `catalog_sync_runs`.

## Prompt to hand to Claude Code

```
Read RUNBOOK_BLOCK_D_CATALOG_FRESHNESS.md in the repo root.

Build the catalog-freshness Supabase Edge Function according to that
spec. Work in this order:

1. Verify the current Supabase Edge Function timeout limits before
   writing any code. Check Supabase docs and confirm the chunking
   budget the function should target. Report what you find.
2. Create the catalog_sync_runs migration. Show me the SQL before
   applying.
3. Create the Edge Function files (index.ts, tmdb.ts, upsert.ts,
   checkpoint.ts). Build locally; do not deploy.
4. Run npm run build at the repo root to confirm no type errors.
5. Show me each file as you finish it. Wait for my OK before moving
   to the next.
6. Do NOT create the pg_cron schedule migration yet. We do that
   manually after the function is verified working from a manual
   invoke.

Tripwires per the runbook: stop if more than 1000 changed titles in
a test run, any is_active=true row would be touched, or TMDb returns
401 on the API key.

Nothing committed. Show diffs when you're done.
```
