"""
TMDb Discover Scraper
---------------------
Paginates TMDb's /discover/movie endpoint across multiple year ranges
to build a comprehensive movie catalog. Two phases:

Phase A (default): /discover/movie pagination — fast, ~5 hours for
  150K titles. Output: discover_results.jsonl
Phase B (--enrich): /movie/{id} detail fetching for runtime/cast/etc.
  Resumable. Output: tmdb_full_catalog.jsonl

Phase A output is sufficient for studio slate selection (title, year,
poster, overview, vote_average, popularity).

Usage:
    python tmdb_discover.py                         # Phase A: full discover
    python tmdb_discover.py --max 500               # Phase A test run
    python tmdb_discover.py --enrich                # Phase B: enrich Phase A
    python tmdb_discover.py --enrich --limit 100    # Phase B test run
"""

import json
import os
import time
import argparse
import logging
from pathlib import Path
from datetime import datetime

try:
    import requests
except ImportError:
    import subprocess, sys
    subprocess.check_call([sys.executable, "-m", "pip", "install",
                           "requests", "-q"])
    import requests

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s  %(message)s",
                    datefmt="%H:%M:%S")
log = logging.getLogger("tmdb_discover")

TMDB_BASE = "https://api.themoviedb.org/3"
TMDB_IMAGE = "https://image.tmdb.org/t/p"
POSTER_SIZE = "w342"
POSTER_SIZE_HD = "w780"
BACKDROP_SIZE = "w1280"
BACKDROP_SIZE_HD = "original"

# Year ranges chosen to balance coverage with TMDb's 500-page cap.
# Each range × popularity.desc gives up to 10K titles.
# Total max coverage: ~90K films across 9 ranges. Some overlap is
# expected and deduplicated by tmdb_id.
YEAR_RANGES = [
    (None, 1950),    # Classic era
    (1951, 1970),    # Golden age
    (1971, 1985),    # New Hollywood
    (1986, 1995),    # 80s/90s
    (1996, 2005),    # Late 90s/early 00s
    (2006, 2015),    # Streaming era begins
    (2016, 2020),    # Pre-COVID
    (2021, 2025),    # Recent
    (2026, None),    # Current/upcoming
]


def get_api_key() -> str:
    key = os.environ.get("TMDB_API_KEY", "").strip()
    if not key:
        raise ValueError(
            "\n\nMissing TMDB_API_KEY.\n"
            "  Get one at https://www.themoviedb.org/settings/api\n"
            "  Set in scripts/scraper/.env\n"
        )
    return key


def tmdb_get(path: str, params: dict | None = None,
             retries: int = 4) -> dict | None:
    api_key = get_api_key()
    url = f"{TMDB_BASE}{path}"
    full = {"api_key": api_key, "language": "en-US",
            "include_adult": False}
    if params:
        full.update(params)

    for attempt in range(retries):
        try:
            r = requests.get(url, params=full, timeout=20)
            if r.status_code == 429:
                wait = int(r.headers.get("Retry-After", 5))
                log.warning(f"Rate limited. Waiting {wait}s")
                time.sleep(wait)
                continue
            if r.status_code == 404:
                return None
            r.raise_for_status()
            return r.json()
        except requests.RequestException as e:
            wait = 2 ** attempt
            log.warning(f"Attempt {attempt+1}/{retries}: {e}. "
                        f"Retry in {wait}s")
            time.sleep(wait)
    return None


def poster_url(path: str | None, size: str = POSTER_SIZE) -> str | None:
    if not path:
        return None
    return f"{TMDB_IMAGE}/{size}{path}"


def normalize_discover_record(item: dict) -> dict:
    """Convert TMDb discover result to our canonical shape."""
    release = item.get("release_date") or ""
    year = int(release[:4]) if release[:4].isdigit() else None

    return {
        "tmdb_id":         item.get("id"),
        "title":           item.get("title"),
        "original_title":  item.get("original_title"),
        "year":            year,
        "release_date":    release,
        "overview":        item.get("overview"),
        "poster_url":      poster_url(item.get("poster_path"),
                                      POSTER_SIZE),
        "poster_url_hd":   poster_url(item.get("poster_path"),
                                      POSTER_SIZE_HD),
        "backdrop_url":    poster_url(item.get("backdrop_path"),
                                      BACKDROP_SIZE),
        "backdrop_url_hd": poster_url(item.get("backdrop_path"),
                                      BACKDROP_SIZE_HD),
        "vote_average":    item.get("vote_average"),
        "popularity":      item.get("popularity"),
        "genre_ids":       item.get("genre_ids") or [],
        "type":            "MOVIE",
        "scraped_at":      datetime.utcnow().isoformat(),
    }


def discover_pages(year_start: int | None,
                   year_end: int | None,
                   output_handle,
                   seen_ids: set,
                   max_pages: int = 500,
                   delay: float = 0.05) -> int:
    """Paginate /discover/movie for a year range. Returns count added."""
    added = 0
    params_base = {"sort_by": "popularity.desc"}
    if year_start:
        params_base["primary_release_date.gte"] = f"{year_start}-01-01"
    if year_end:
        params_base["primary_release_date.lte"] = f"{year_end}-12-31"

    for page in range(1, max_pages + 1):
        params = {**params_base, "page": page}
        data = tmdb_get("/discover/movie", params)
        if not data or not data.get("results"):
            break

        for item in data["results"]:
            tmdb_id = item.get("id")
            if not tmdb_id or tmdb_id in seen_ids:
                continue
            seen_ids.add(tmdb_id)
            record = normalize_discover_record(item)
            output_handle.write(json.dumps(record,
                                           ensure_ascii=False) + "\n")
            added += 1

        output_handle.flush()
        if page % 25 == 0:
            total_pages = data.get("total_pages", "?")
            log.info(f"    Page {page}/{min(total_pages, max_pages)} "
                     f"— +{added} new (total seen: {len(seen_ids):,})")

        # TMDb cap: 500 pages
        if page >= data.get("total_pages", 0):
            break

        time.sleep(delay)

    return added


def run_discover(output_path: str,
                 max_total: int = 0,
                 delay: float = 0.05) -> None:
    """Phase A: paginate /discover/movie across year ranges."""
    seen_ids = set()
    total_added = 0

    log.info(f"Starting TMDb discover phase. Output: {output_path}")
    log.info(f"Year ranges: {len(YEAR_RANGES)}")

    with open(output_path, "w", encoding="utf-8") as out:
        for ys, ye in YEAR_RANGES:
            label = f"{ys or '...'}-{ye or '...'}"
            log.info(f"\n  Year range {label}")
            added = discover_pages(ys, ye, out, seen_ids,
                                   max_pages=500, delay=delay)
            total_added += added
            log.info(f"  Added {added:,} from {label} "
                     f"(running total: {total_added:,})")

            if max_total and total_added >= max_total:
                log.info(f"  Reached --max limit of {max_total}. "
                         f"Stopping.")
                break

    log.info(f"\nDone. {total_added:,} unique movies → {output_path}")


def enrich_record(record: dict,
                  delay: float = 0.05) -> dict:
    """Phase B: fetch /movie/{id} for runtime, genres, cast, crew."""
    tmdb_id = record.get("tmdb_id")
    if not tmdb_id:
        return record

    details = tmdb_get(
        f"/movie/{tmdb_id}",
        {"append_to_response": "credits,videos,external_ids,keywords"}
    )
    if not details:
        return {**record, "tmdb_matched": False,
                "enriched_at": datetime.utcnow().isoformat()}

    credits = details.get("credits") or {}
    videos = details.get("videos") or {}
    ext_ids = details.get("external_ids") or {}
    keywords = details.get("keywords") or {}

    # Cast (top 15)
    cast = [
        {"name": c.get("name"),
         "character": c.get("character"),
         "order": c.get("order"),
         "profile_url": poster_url(c.get("profile_path"), "w185")}
        for c in (credits.get("cast") or [])[:15]
        if c.get("name")
    ]

    # Crew (directors, writers, producers)
    crew_data = {"directors": [], "writers": [], "producers": [],
                 "cinematographers": []}
    for c in (credits.get("crew") or []):
        job = (c.get("job") or "").lower()
        name = c.get("name")
        if not name:
            continue
        if job == "director":
            crew_data["directors"].append(name)
        elif job in ("writer", "screenplay", "story"):
            crew_data["writers"].append(name)
        elif job == "producer":
            crew_data["producers"].append(name)
        elif job in ("director of photography", "cinematographer"):
            crew_data["cinematographers"].append(name)

    # Trailers (YouTube only, official trailers first)
    trailers = []
    for v in (videos.get("results") or []):
        if v.get("site") == "YouTube":
            trailers.append({
                "type": v.get("type"),
                "name": v.get("name"),
                "key": v.get("key"),
                "url": f"https://www.youtube.com/watch?v={v.get('key')}",
                "embed": f"https://www.youtube.com/embed/{v.get('key')}",
                "official": v.get("official", False),
            })
    trailers.sort(key=lambda x: (not x["official"],
                                  x["type"] != "Trailer"))

    enriched = {
        **record,
        "imdb_id":        ext_ids.get("imdb_id"),
        "tagline":        details.get("tagline"),
        "runtime_mins":   details.get("runtime"),
        "genres":         [g["name"] for g in (details.get("genres") or [])],
        "countries":      [c["iso_3166_1"]
                           for c in (details.get("production_countries") or [])],
        "keywords":       [k["name"]
                           for k in (keywords.get("keywords") or [])],
        "cast":           cast,
        "crew":           crew_data,
        "trailers":       trailers,
        "tmdb_matched":   True,
        "enriched_at":    datetime.utcnow().isoformat(),
    }

    time.sleep(delay)
    return enriched


def run_enrich(input_path: str,
               output_path: str,
               limit: int = 0,
               delay: float = 0.05) -> None:
    """Phase B: enrich Phase A output with /movie/{id} details."""
    input_file = Path(input_path)
    if not input_file.exists():
        raise FileNotFoundError(f"Input not found: {input_path}")

    # Resume support: skip already-enriched tmdb_ids
    already_done = set()
    if Path(output_path).exists():
        with open(output_path, "r") as f:
            for line in f:
                try:
                    r = json.loads(line)
                    if r.get("tmdb_id"):
                        already_done.add(r["tmdb_id"])
                except:
                    pass
        if already_done:
            log.info(f"Resuming. Skipping {len(already_done):,} "
                     f"already-enriched.")

    lines = input_file.read_text(encoding="utf-8").strip().splitlines()
    total = len(lines)
    log.info(f"Input: {total:,} records → enrich")

    processed = 0
    enriched_count = 0

    with open(output_path, "a", encoding="utf-8") as out:
        for line in lines:
            try:
                record = json.loads(line.strip())
            except json.JSONDecodeError:
                continue
            if record.get("tmdb_id") in already_done:
                continue

            enriched = enrich_record(record, delay=delay)
            out.write(json.dumps(enriched, ensure_ascii=False) + "\n")
            out.flush()

            if enriched.get("tmdb_matched"):
                enriched_count += 1
            processed += 1

            if processed % 100 == 0:
                log.info(f"  [{processed:,}/{total:,}] "
                         f"enriched: {enriched_count:,}")

            if limit and processed >= limit:
                log.info(f"  Reached limit {limit}. Stopping.")
                break

    log.info(f"\nDone. {processed:,} processed, "
             f"{enriched_count:,} matched → {output_path}")


def main():
    p = argparse.ArgumentParser(description="TMDb discover + enrich")
    p.add_argument("--enrich", action="store_true",
                   help="Phase B mode")
    p.add_argument("--max", type=int, default=0,
                   help="Phase A: max total records (0=all)")
    p.add_argument("--limit", type=int, default=0,
                   help="Phase B: max records to enrich (0=all)")
    p.add_argument("--input", default="discover_results.jsonl",
                   help="Phase B input")
    p.add_argument("--output", default=None,
                   help="Output path (default depends on phase)")
    p.add_argument("--delay", type=float, default=0.05,
                   help="Seconds between API calls")
    args = p.parse_args()

    try:
        get_api_key()
    except ValueError as e:
        print(e)
        return

    if args.enrich:
        out = args.output or "tmdb_full_catalog.jsonl"
        run_enrich(args.input, out, args.limit, args.delay)
    else:
        out = args.output or "discover_results.jsonl"
        run_discover(out, args.max, args.delay)


if __name__ == "__main__":
    main()
