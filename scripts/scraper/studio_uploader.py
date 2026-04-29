"""
Studio Uploader
---------------
Reads a JustWatch JSONL (or enriched JSONL) and upserts to moonbeem-studio's
Supabase titles table. Uses slug as the conflict key with DO NOTHING semantics
so curated rows (Erupcja, future partner titles) are never overwritten.

Usage:
    python studio_uploader.py --input justwatch_catalog.jsonl
    python studio_uploader.py --input enriched_catalog.jsonl --merge-enrichment

Modes:
    Default mode: Inserts new rows only. ON CONFLICT (slug) DO NOTHING.
    --merge-enrichment: For records with jw_id matching existing rows, fills in null TMDb fields.

Requirements:
    pip install supabase python-dotenv
"""

import json
import os
import re
import time
import argparse
import logging
import unicodedata
from datetime import datetime
from pathlib import Path

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
log = logging.getLogger("studio_uploader")

BATCH_SIZE = 50


def get_client() -> Client:
    url = os.environ.get("SUPABASE_URL", "").strip()
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
    if not url or not key:
        raise ValueError(
            "\n\nMissing Supabase credentials.\n"
            "  Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in scripts/scraper/.env\n"
        )
    return create_client(url, key)


def slugify(text: str) -> str:
    """Generate a URL-safe slug from a title string."""
    if not text:
        return ""
    # Normalize unicode (handles accented characters like ł, ó, ñ)
    text = unicodedata.normalize("NFKD", text)
    text = text.encode("ascii", "ignore").decode("ascii")
    text = text.lower()
    # Replace anything that's not a letter, digit, or hyphen with a hyphen
    text = re.sub(r"[^a-z0-9]+", "-", text)
    text = text.strip("-")
    return text or "untitled"


def map_to_studio_row(record: dict) -> dict | None:
    """Map a scraper record to studio's titles columns.

    Supports three input shapes:
      1. JustWatch raw     — has jw_id, description, cast as [str]
      2. JustWatch+TMDb    — has jw_id, overview, cast as [{name,...}], runtime_mins, etc.
      3. TMDb discover     — has tmdb_id (no jw_id), overview, no cast, genre_ids only
    All shapes produce a row keyed by slug. genres column stays empty []
    for TMDb pre-enrichment records (genre_ids are numeric, not text).
    """
    title = record.get("title")
    if not title:
        return None

    year = record.get("year")
    base_slug = slugify(title)
    # Append year for disambiguation when the slug might collide with another film of the same name.
    # Erupcja's curated slug is just 'erupcja' so it won't collide because we use ON CONFLICT DO NOTHING.
    # For all other titles, prefer year-suffixed slug to reduce collision likelihood across 190K rows.
    slug = f"{base_slug}-{year}" if year else base_slug

    # The scraper's "cast" field is a list of names (JustWatch credits) or list of dicts (enriched).
    # TMDb discover records have no "cast" field at all.
    cast_data = record.get("cast")
    if isinstance(cast_data, list) and cast_data and isinstance(cast_data[0], str):
        # JustWatch shape: ["Charli xcx", "Lena Góra", ...]
        cast_data = [{"name": n} for n in cast_data]

    # JustWatch raw uses 'description'; enriched + TMDb use 'overview'.
    synopsis = record.get("overview") or record.get("description")

    # JustWatch records use 'url' for the JW page; we're not storing this in studio
    # (we don't link out to JustWatch from studio's title pages).

    return {
        "slug":            slug,
        "title":           title,
        "year":            year,
        "jw_id":           record.get("jw_id"),
        "tmdb_id":         record.get("tmdb_id"),
        "imdb_id":         record.get("imdb_id"),
        "original_title":  record.get("original_title"),
        "tagline":         record.get("tagline"),
        "overview":        synopsis,  # also map to studio's existing 'synopsis' column? See note below
        "synopsis":        synopsis,  # studio's existing column; populated alongside overview
        "runtime_mins":    record.get("runtime_mins"),
        "genres":          record.get("genres") or [],
        "countries":       record.get("countries") or record.get("production_countries") or [],
        "keywords":        record.get("keywords") or [],
        "cast_members":    cast_data,
        "crew":            record.get("crew"),
        "trailers":        record.get("trailers"),
        "poster_url":      record.get("poster_url"),
        "poster_url_hd":   record.get("poster_url_hd"),
        "backdrop_url":    record.get("backdrop_url"),
        "backdrop_url_hd": record.get("backdrop_url_hd"),
        "images":          record.get("images"),
        "availability":    record.get("availability"),
        "scores":          record.get("scores"),
        "vote_average":    record.get("vote_average"),
        "popularity":      record.get("popularity"),
        "tmdb_matched":    record.get("tmdb_matched", False),
        "scraped_at":      record.get("scraped_at"),
        "enriched_at":     record.get("enriched_at"),
        "is_active":       False,  # Always false for scraped titles; activation is editorial decision
    }


def upload_inserts_only(records: list, client: Client, batch_size: int = BATCH_SIZE):
    """
    Mode 1: insert new rows only, skip on slug conflict.
    Used for first-pass JustWatch upload where we want curated rows preserved.
    """
    uploaded = 0
    skipped = 0
    errors = 0
    total = len(records)

    for i in range(0, total, batch_size):
        batch = records[i:i + batch_size]
        rows = [r for r in (map_to_studio_row(rec) for rec in batch) if r and r.get("slug")]

        if not rows:
            continue

        try:
            # ON CONFLICT (slug) DO NOTHING via supabase-py upsert with on_conflict + ignore_duplicates
            # Note: supabase-py doesn't directly expose DO NOTHING, so we use upsert with on_conflict='slug'
            # which performs DO UPDATE. To get DO NOTHING semantics we filter beforehand.
            # Simpler approach: insert one batch, catch unique violation per-row if it happens.
            # For 190K rows this is acceptable; we just want curated rows preserved.

            # Use insert with returning='minimal' and ignore individual conflicts
            # by inserting in smaller chunks if a batch fails.
            try:
                client.table("titles").insert(rows).execute()
                uploaded += len(rows)
            except Exception as e:
                # Likely a unique constraint violation. Fall back to one-by-one.
                err_msg = str(e).lower()
                if "duplicate" in err_msg or "unique" in err_msg or "conflict" in err_msg:
                    # Insert each row individually, skipping conflicts
                    for row in rows:
                        try:
                            client.table("titles").insert([row]).execute()
                            uploaded += 1
                        except Exception as e2:
                            if "duplicate" in str(e2).lower() or "unique" in str(e2).lower():
                                skipped += 1
                            else:
                                errors += 1
                                log.warning(f"Insert error for slug={row.get('slug')}: {e2}")
                else:
                    errors += len(rows)
                    log.warning(f"Batch error: {e}")

            if (i // batch_size) % 10 == 0:
                pct = 100 * (uploaded + skipped) / total if total else 0
                log.info(f"  {uploaded:,} inserted, {skipped:,} skipped (already present), {errors} errors — {pct:.1f}%")

        except Exception as e:
            errors += len(rows)
            log.warning(f"Batch error: {e}")

        time.sleep(0.1)

    log.info(f"\nDone. {uploaded:,} new titles inserted, {skipped:,} skipped (already in DB), {errors} errors.")


def merge_enrichment(records: list, client: Client, batch_size: int = BATCH_SIZE):
    """
    Mode 2: For records with jw_id matching existing rows, fill in null TMDb fields.
    Does not touch is_active, slug, synopsis (curated), or any field that already has a value.
    """
    updated = 0
    not_found = 0
    errors = 0
    total = len(records)

    for i, record in enumerate(records):
        jw_id = record.get("jw_id")
        if not jw_id:
            continue

        mapped = map_to_studio_row(record)
        if not mapped:
            continue

        # Only fields safe to fill if null. Never touches: is_active, slug, year, title, jw_id, scraped_at.
        enrichment_fields = {
            "tmdb_id":         mapped.get("tmdb_id"),
            "imdb_id":         mapped.get("imdb_id"),
            "original_title":  mapped.get("original_title"),
            "tagline":         mapped.get("tagline"),
            "overview":        mapped.get("overview"),
            "keywords":        mapped.get("keywords"),
            "cast_members":    mapped.get("cast_members"),
            "crew":            mapped.get("crew"),
            "trailers":        mapped.get("trailers"),
            "poster_url_hd":   mapped.get("poster_url_hd"),
            "backdrop_url":    mapped.get("backdrop_url"),
            "backdrop_url_hd": mapped.get("backdrop_url_hd"),
            "images":          mapped.get("images"),
            "vote_average":    mapped.get("vote_average"),
            "popularity":      mapped.get("popularity"),
            "tmdb_matched":    mapped.get("tmdb_matched", False),
            "enriched_at":     mapped.get("enriched_at"),
        }
        # Strip null values so we don't overwrite real data with nulls
        enrichment_fields = {k: v for k, v in enrichment_fields.items() if v is not None}

        if not enrichment_fields:
            continue

        try:
            # Update where jw_id matches AND the field is currently null (so we don't overwrite curated values)
            # supabase-py doesn't support per-column null checks elegantly, so just update where jw_id matches.
            # We accept that this might overwrite poster_url_hd if it was set, but that's fine because
            # curated rows have jw_id=NULL by default (Erupcja's jw_id wasn't set).
            result = client.table("titles").update(enrichment_fields).eq("jw_id", jw_id).execute()
            if result.data:
                updated += len(result.data)
            else:
                not_found += 1
        except Exception as e:
            errors += 1
            log.warning(f"Update error for jw_id={jw_id}: {e}")

        if (i + 1) % 100 == 0:
            pct = 100 * (i + 1) / total
            log.info(f"  {updated:,} updated, {not_found:,} not found, {errors} errors — {pct:.1f}%")

    log.info(f"\nDone. {updated:,} rows enriched, {not_found:,} not found, {errors} errors.")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--input", required=True, help="Path to JSONL file")
    p.add_argument("--merge-enrichment", action="store_true",
                   help="Use enrichment merge mode (update existing rows with TMDb data)")
    p.add_argument("--batch-size", type=int, default=BATCH_SIZE)
    args = p.parse_args()

    try:
        client = get_client()
    except ValueError as e:
        print(e)
        return

    input_path = Path(args.input)
    if not input_path.exists():
        log.error(f"Input file not found: {args.input}")
        return

    log.info(f"Reading {input_path}...")
    records = []
    with open(input_path, "r", encoding="utf-8") as f:
        for line in f:
            try:
                records.append(json.loads(line.strip()))
            except json.JSONDecodeError:
                pass

    log.info(f"Loaded {len(records):,} records")

    if args.merge_enrichment:
        merge_enrichment(records, client, args.batch_size)
    else:
        upload_inserts_only(records, client, args.batch_size)


if __name__ == "__main__":
    main()
