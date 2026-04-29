# Film Intelligence Scraper

Pipeline that builds studio's `titles` catalog (~190K films) from JustWatch + TMDb. Output rows are inserted into studio's Supabase as `is_active=false` for editorial activation later. Curated rows (e.g. Erupcja) are never overwritten.

## Overview

Three phases:

1. **Scrape** — `justwatch_full_scraper.py` walks JustWatch's GraphQL API and writes `justwatch_catalog.jsonl` (one record per line). JustWatch gives us: title, year, JW id, genres, countries, basic cast, poster, availability, scores.
2. **Upload (insert)** — `studio_uploader.py` reads that JSONL and inserts new rows into studio's `titles` table. Slug-based conflict key with `DO NOTHING` semantics, so re-runs are idempotent and curated rows are preserved.
3. **Enrich** — `tmdb_enrichment.py` reads the JustWatch JSONL, matches each record to TMDb, and writes `enriched_catalog.jsonl` with TMDb fields layered on top (overview, tagline, full cast/crew, trailers, HD posters, popularity, vote_average, etc.). This phase is rate-limited and can run for several days on a full 190K catalog.
4. **Re-upload (merge)** — `studio_uploader.py --merge-enrichment` reads the enriched JSONL and updates existing rows (matched by `jw_id`) with TMDb fields. Does not touch `is_active`, `slug`, `title`, `year`, `synopsis`, or `scraped_at`.

## Setup

```bash
cd scripts/scraper
cp .env.example .env
# edit .env and fill in real values for SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TMDB_API_KEY

python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

The `.env` is git-ignored. The service role key bypasses RLS, so keep it out of any client-facing code.

## Commands

### Test run (100 titles, ~30–60 seconds)

```bash
python justwatch_full_scraper.py --max 100 --movies-only --output test_catalog.jsonl
python studio_uploader.py --input test_catalog.jsonl
```

### Full run (~190K titles)

```bash
# Phase 1: scrape JustWatch — runs for several hours
python justwatch_full_scraper.py --movies-only --output justwatch_catalog.jsonl

# Phase 2: upload JustWatch-only data to studio
python studio_uploader.py --input justwatch_catalog.jsonl

# Phase 3: enrich with TMDb — runs for several days, can be backgrounded
python tmdb_enrichment.py --input justwatch_catalog.jsonl --output enriched_catalog.jsonl

# Phase 4: merge enrichment back into studio
python studio_uploader.py --input enriched_catalog.jsonl --merge-enrichment
```

## Idempotency and resume

- **Scraper**: writes line-by-line to JSONL. If interrupted, re-running starts over (the scraper does its own dedup via `jw_id`).
- **Enrichment**: also writes line-by-line. If interrupted, you can resume by passing `--skip-existing` (see `tmdb_enrichment.py --help`).
- **Studio uploader (insert mode)**: uses `slug` as the conflict key with `DO NOTHING`. Safe to re-run any time — already-inserted rows are skipped.
- **Studio uploader (merge mode)**: matches on `jw_id`. Re-runs replay enrichment fields. Curated rows have no `jw_id` so they're untouched.

## Notes

- Scraper output JSONL files can be hundreds of MB and are git-ignored.
- The `is_active=false` default on scraped rows means they don't show up on creator slates or `/t/[slug]` pages until an editor flips the flag.
- Slug strategy: `slugify(title)-{year}` for scraped rows; curated rows use clean slugs (e.g. `erupcja`). The `-{year}` suffix reduces collisions across the 190K catalog.
