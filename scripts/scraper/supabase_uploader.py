"""
Supabase Uploader
------------------
Reads enriched_catalog.jsonl and upserts every record into Supabase.
Safe to run multiple times — uses jw_id as the unique key so re-runs
just update existing records rather than creating duplicates.

Usage:
    python supabase_uploader.py --input enriched_catalog.jsonl

Requirements:
    pip install supabase
    export SUPABASE_URL=https://your-project.supabase.co
    export SUPABASE_ANON_KEY=your-anon-key
"""

import json
import os
import time
import argparse
import logging
from pathlib import Path
from datetime import datetime

try:
    from supabase import create_client, Client
except ImportError:
    import subprocess, sys
    subprocess.check_call([sys.executable, "-m", "pip", "install", "supabase", "-q"])
    from supabase import create_client, Client

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger("uploader")

BATCH_SIZE = 50  # Records per upsert call


def get_client() -> Client:
    url = os.environ.get("SUPABASE_URL", "").strip()
    key = os.environ.get("SUPABASE_ANON_KEY", "").strip()
    if not url or not key:
        raise ValueError(
            "\n\n❌ Missing Supabase credentials.\n"
            "   Set: SUPABASE_URL and SUPABASE_ANON_KEY\n"
            "   (See Part 1B of the setup guide)\n"
        )
    return create_client(url, key)


def flatten_for_db(record: dict) -> dict:
    """
    Flatten/clean a record for Supabase insertion.
    Postgres arrays need to be real lists; JSONB fields stay as dicts.
    """
    availability = record.get("availability") or {}

    return {
        "jw_id":            record.get("jw_id"),
        "tmdb_id":          record.get("tmdb_id"),
        "imdb_id":          record.get("imdb_id"),
        "type":             record.get("type", "MOVIE"),
        "title":            record.get("title") or "",
        "original_title":   record.get("original_title"),
        "year":             record.get("year"),
        "tagline":          record.get("tagline"),
        "overview":         record.get("overview") or record.get("description"),
        "runtime_mins":     record.get("runtime_mins"),
        "genres":           record.get("genres") or [],
        "countries":        record.get("countries") or [],
        "keywords":         record.get("keywords") or [],
        "cast":             record.get("cast") or [],
        "crew":             record.get("crew") or {},
        "trailers":         record.get("trailers") or [],
        "poster_url":       record.get("poster_url"),
        "poster_url_hd":    record.get("poster_url_hd"),
        "backdrop_url":     record.get("backdrop_url"),
        "backdrop_url_hd":  record.get("backdrop_url_hd"),
        "images":           record.get("images") or {},
        "availability":     availability,
        "scores":           record.get("scores") or {},
        "vote_average":     record.get("vote_average"),
        "popularity":       record.get("popularity"),
        "tmdb_matched":     record.get("tmdb_matched", False),
        "scraped_at":       record.get("scraped_at"),
        "enriched_at":      record.get("enriched_at"),
        "updated_at":       datetime.utcnow().isoformat(),
    }


def upload(input_path: str, batch_size: int = BATCH_SIZE) -> None:
    supabase = get_client()
    lines = Path(input_path).read_text(encoding="utf-8").strip().splitlines()
    total = len(lines)
    log.info(f"Uploading {total:,} records from {input_path}")

    records = []
    for line in lines:
        try:
            records.append(json.loads(line))
        except json.JSONDecodeError:
            pass

    uploaded = 0
    errors = 0

    for i in range(0, len(records), batch_size):
        batch = records[i:i + batch_size]
        rows = [flatten_for_db(r) for r in batch if r.get("jw_id")]

        try:
            result = supabase.table("titles").upsert(rows, on_conflict="jw_id").execute()
            uploaded += len(rows)
            if (i // batch_size) % 10 == 0:
                pct = 100 * uploaded / total
                log.info(f"  {uploaded:,}/{total:,} ({pct:.1f}%)")
        except Exception as e:
            errors += len(rows)
            log.warning(f"Batch error at record {i}: {e}")
            time.sleep(2)

        time.sleep(0.1)  # polite pause between batches

    log.info(f"\n✅ Done. {uploaded:,} uploaded, {errors} errors.")


def main():
    p = argparse.ArgumentParser(description="Upload enriched catalog to Supabase")
    p.add_argument("--input",      default="enriched_catalog.jsonl")
    p.add_argument("--batch-size", type=int, default=BATCH_SIZE)
    args = p.parse_args()

    try:
        get_client()
    except ValueError as e:
        print(e)
        return

    upload(args.input, args.batch_size)


if __name__ == "__main__":
    main()
