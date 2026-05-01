"""
Discover Full Catalog (movies + TV) — Phase 2 of overnight scrape.
------------------------------------------------------------------
Downloads TMDb's daily ID exports and inserts stub rows into public.titles
for every tmdb_id we don't already have. Stub rows have:
    tmdb_id, media_type, popularity, slug='tmdb-{m|t}-{id}', title='TMDB:{id}',
    is_active=false, enriched_at=null
The slug + title are placeholders; the enrichment phase overwrites them.

Existing rows are NEVER touched — ON CONFLICT (tmdb_id) DO NOTHING. This
preserves curated rows (is_active, slug, etc.) and any prior enrichment.

Run:
    cd scripts/scraper
    source .venv/bin/activate
    python discover_full_catalog.py [--limit N] [--dry-run] [--media movie|tv|both]

Flags:
    --limit N      Cap insertions to N per media type (for dry runs)
    --dry-run      Download and parse, but do not write to DB
    --media TYPE   Restrict to one media type (default: both)
"""

from __future__ import annotations

import argparse
import gzip
import io
import json
import logging
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

try:
    import requests
except ImportError:
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "requests", "-q"])
    import requests

try:
    from supabase import create_client, Client
except ImportError:
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "supabase", "-q"])
    from supabase import create_client, Client

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("discover")

EXPORT_BASE = "https://files.tmdb.org/p/exports"
INSERT_BATCH = 500
EXISTING_FETCH_BATCH = 1000


def env(name: str) -> str:
    v = os.environ.get(name)
    if not v:
        log.error("Missing env var: %s", name)
        sys.exit(1)
    return v


def export_url(media: str, when: datetime) -> str:
    name = "movie_ids" if media == "movie" else "tv_series_ids"
    stamp = when.strftime("%m_%d_%Y")
    return f"{EXPORT_BASE}/{name}_{stamp}.json.gz"


def download_export(media: str) -> bytes:
    """TMDb regenerates exports daily ~08:00 UTC. Try today, fall back to
    yesterday and the day before."""
    now = datetime.now(timezone.utc)
    last_err = None
    for delta in (0, 1, 2):
        when = now - timedelta(days=delta)
        url = export_url(media, when)
        log.info("trying %s", url)
        try:
            r = requests.get(url, timeout=120, stream=True)
            if r.status_code == 200:
                log.info("downloaded %s (%s bytes)", url, r.headers.get("content-length", "?"))
                return r.content
            last_err = f"{r.status_code} {url}"
        except requests.RequestException as exc:
            last_err = f"{exc} {url}"
    raise RuntimeError(f"could not download {media} export: {last_err}")


def parse_export(blob: bytes):
    """Yield {id, popularity, original_title|original_name, adult, video} dicts."""
    with gzip.GzipFile(fileobj=io.BytesIO(blob), mode="rb") as gz:
        for raw in gz:
            line = raw.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                continue


def fetch_existing_keys(sb: Client) -> set[tuple[int, str]]:
    """Page through public.titles and return the set of (tmdb_id, media_type)
    tuples already present. TMDb IDs are namespaced by media type, so we must
    dedupe by the pair, not by tmdb_id alone."""
    log.info("fetching existing (tmdb_id, media_type) keys from DB...")
    keys: set[tuple[int, str]] = set()
    last_id = "00000000-0000-0000-0000-000000000000"
    while True:
        r = (
            sb.table("titles")
            .select("id, tmdb_id, media_type")
            .not_.is_("tmdb_id", "null")
            .gt("id", last_id)
            .order("id")
            .limit(EXISTING_FETCH_BATCH)
            .execute()
        )
        rows = r.data or []
        if not rows:
            break
        for row in rows:
            keys.add((int(row["tmdb_id"]), row.get("media_type") or "movie"))
        last_id = rows[-1]["id"]
    log.info("existing keys: %d", len(keys))
    return keys


def chunked(seq, n):
    for i in range(0, len(seq), n):
        yield seq[i : i + n]


def stub_row(entry: dict, media: str) -> dict:
    tmdb_id = int(entry["id"])
    name = entry.get("original_title") or entry.get("original_name") or f"TMDB:{tmdb_id}"
    pop = entry.get("popularity")
    return {
        "tmdb_id": tmdb_id,
        "media_type": media,
        "popularity": pop if isinstance(pop, (int, float)) else None,
        "slug": f"tmdb-{'m' if media == 'movie' else 't'}-{tmdb_id}",
        "title": name[:300] if isinstance(name, str) else f"TMDB:{tmdb_id}",
        "is_active": False,
    }


def discover(media: str, limit: int | None, dry_run: bool, sb: Client | None) -> tuple[int, int, int]:
    blob = download_export(media)
    parsed = 0
    candidate = 0
    inserted = 0

    existing = set() if dry_run or sb is None else fetch_existing_keys(sb)

    pending: list[dict] = []
    skipped_adult = 0
    skipped_existing = 0

    for entry in parse_export(blob):
        parsed += 1
        if entry.get("adult") is True:
            skipped_adult += 1
            continue
        tmdb_id = entry.get("id")
        if not isinstance(tmdb_id, int):
            continue
        key = (tmdb_id, media)
        if key in existing:
            skipped_existing += 1
            continue
        candidate += 1
        pending.append(stub_row(entry, media))
        existing.add(key)
        if limit is not None and candidate >= limit:
            break

    log.info(
        "%s parsed=%d candidate=%d skipped_adult=%d skipped_existing=%d",
        media,
        parsed,
        candidate,
        skipped_adult,
        skipped_existing,
    )

    if dry_run:
        log.info("dry-run: would insert %d %s stubs", len(pending), media)
        for row in pending[:3]:
            log.info("  sample: %s", row)
        return parsed, candidate, 0

    assert sb is not None
    # We dedupe against existing tmdb_ids client-side. The partial unique
    # index on tmdb_id catches any race; the regular unique on slug catches
    # double-runs (stub slugs are deterministic per tmdb_id). Use upsert
    # on slug with ignore_duplicates so reruns are no-ops.
    for batch in chunked(pending, INSERT_BATCH):
        try:
            sb.table("titles").upsert(
                batch,
                on_conflict="slug",
                ignore_duplicates=True,
            ).execute()
            inserted += len(batch)
        except Exception as exc:
            log.warning("batch insert failed (%s rows), retrying per-row: %s", len(batch), exc)
            # Fallback: insert one at a time, skip any 23505 from the partial
            # unique on tmdb_id (e.g., a curated row with the same tmdb_id).
            for row in batch:
                try:
                    sb.table("titles").insert(row).execute()
                    inserted += 1
                except Exception as inner:
                    if "23505" in str(inner):
                        continue
                    log.warning("row insert failed tmdb_id=%s: %s", row.get("tmdb_id"), inner)
    log.info("%s inserted=%d", media, inserted)
    return parsed, candidate, inserted


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=None, help="Cap inserts per media type")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--media", choices=["movie", "tv", "both"], default="both")
    args = ap.parse_args()

    sb: Client | None = None
    if not args.dry_run:
        sb_url = env("SUPABASE_URL")
        sb_key = env("SUPABASE_SERVICE_ROLE_KEY")
        sb = create_client(sb_url, sb_key)

    media_types = ["movie", "tv"] if args.media == "both" else [args.media]
    totals = {}
    t0 = time.monotonic()
    for media in media_types:
        parsed, candidate, inserted = discover(media, args.limit, args.dry_run, sb)
        totals[media] = (parsed, candidate, inserted)

    elapsed = time.monotonic() - t0
    log.info("=== Discovery summary (%.1fs) ===", elapsed)
    for media, (p, c, i) in totals.items():
        log.info("  %s: parsed=%d candidate=%d inserted=%d", media, p, c, i)
    return 0


if __name__ == "__main__":
    sys.exit(main())
