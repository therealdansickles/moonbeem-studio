"""
TMDb Enrichment Layer
----------------------
Takes the JustWatch catalog JSONL and enriches every title with
officially licensed artwork and metadata from The Movie Database (TMDb).

What this adds per title:
  - Poster image (high-res, hosted on TMDb CDN — licensed for app use)
  - Backdrop / hero image
  - Trailer + clip URLs (YouTube)
  - Full cast & crew
  - Director, writer credits
  - Production companies
  - Official keywords/tags
  - Full description
  - All available languages

Output: enriched_catalog.jsonl  (one record per line, ready for Supabase)

Setup:
  1. Get a free TMDb API key at https://www.themoviedb.org/settings/api
  2. Set it as an environment variable:  export TMDB_API_KEY=your_key_here
  3. Run: python tmdb_enrichment.py --input justwatch_catalog.jsonl

Requirements:
    pip install requests python-dotenv
"""

import json
import time
import os
import argparse
import logging
from pathlib import Path
from datetime import datetime

try:
    import requests
except ImportError:
    import subprocess, sys
    subprocess.check_call([sys.executable, "-m", "pip", "install", "requests", "-q"])
    import requests

# Optional: load from .env file
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(message)s",
    datefmt="%H:%M:%S"
)
log = logging.getLogger("tmdb")

# ─── TMDb config ──────────────────────────────────────────────────────────────

TMDB_BASE     = "https://api.themoviedb.org/3"
TMDB_IMAGE    = "https://image.tmdb.org/t/p"

# Image sizes available from TMDb
POSTER_SIZES  = { "thumb": "w185", "card": "w342", "full": "w500", "hd": "w780" }
BACKDROP_SIZES= { "card": "w780", "full": "w1280", "hd": "original" }

# ─── API client ───────────────────────────────────────────────────────────────

def get_api_key() -> str:
    key = os.environ.get("TMDB_API_KEY", "").strip()
    if not key:
        raise ValueError(
            "\n\n❌ No TMDB_API_KEY found.\n"
            "   1. Get a free key at: https://www.themoviedb.org/settings/api\n"
            "   2. Set it: export TMDB_API_KEY=your_key_here\n"
            "   3. Or create a .env file with: TMDB_API_KEY=your_key_here\n"
        )
    return key


def tmdb_get(path: str, params: dict = None, retries: int = 4) -> dict | None:
    """Make a TMDb API GET request with retry logic."""
    api_key = get_api_key()
    url = f"{TMDB_BASE}{path}"
    full_params = {"api_key": api_key, "language": "en-US"}
    if params:
        full_params.update(params)

    for attempt in range(retries):
        try:
            r = requests.get(url, params=full_params, timeout=15)
            if r.status_code == 429:  # Rate limited
                wait = int(r.headers.get("Retry-After", 10))
                log.warning(f"Rate limited. Waiting {wait}s…")
                time.sleep(wait)
                continue
            if r.status_code == 404:
                return None
            r.raise_for_status()
            return r.json()
        except requests.RequestException as e:
            wait = 2 ** attempt
            log.warning(f"Attempt {attempt+1}/{retries}: {e}. Retry in {wait}s…")
            time.sleep(wait)
    return None


# ─── Image URL helpers ────────────────────────────────────────────────────────

def poster_url(path: str | None, size: str = "card") -> str | None:
    if not path:
        return None
    return f"{TMDB_IMAGE}/{POSTER_SIZES.get(size, 'w342')}{path}"


def backdrop_url(path: str | None, size: str = "full") -> str | None:
    if not path:
        return None
    return f"{TMDB_IMAGE}/{BACKDROP_SIZES.get(size, 'w1280')}{path}"


# ─── TMDb lookups ─────────────────────────────────────────────────────────────

def find_tmdb_id(title: str, year: int | None, media_type: str = "movie") -> dict | None:
    """Search TMDb for a title and return the best match."""
    search_type = "movie" if media_type == "MOVIE" else "tv"
    params = {"query": title, "include_adult": False}
    if year:
        key = "primary_release_year" if search_type == "movie" else "first_air_date_year"
        params[key] = year

    data = tmdb_get(f"/search/{search_type}", params)
    if not data or not data.get("results"):
        # Try without year if no results
        if year:
            params.pop("primary_release_year", None)
            params.pop("first_air_date_year", None)
            data = tmdb_get(f"/search/{search_type}", params)

    if not data or not data.get("results"):
        return None

    results = data["results"]
    # Take top result (TMDb search is generally accurate)
    best = results[0]
    return best


def get_movie_details(tmdb_id: int) -> dict | None:
    """Fetch full movie details including credits, videos, and images."""
    return tmdb_get(
        f"/movie/{tmdb_id}",
        {"append_to_response": "credits,videos,images,keywords,external_ids"}
    )


def get_tv_details(tmdb_id: int) -> dict | None:
    """Fetch full TV show details."""
    return tmdb_get(
        f"/tv/{tmdb_id}",
        {"append_to_response": "credits,videos,images,keywords,external_ids,content_ratings"}
    )


# ─── Data normalization ───────────────────────────────────────────────────────

def extract_trailers(videos: dict) -> list[dict]:
    """Pull YouTube trailers and clips from TMDb video data."""
    if not videos:
        return []
    results = []
    for v in (videos.get("results") or []):
        if v.get("site") == "YouTube":
            results.append({
                "type":     v.get("type"),       # Trailer, Teaser, Clip, etc.
                "name":     v.get("name"),
                "key":      v.get("key"),         # YouTube video ID
                "url":      f"https://www.youtube.com/watch?v={v.get('key')}",
                "embed":    f"https://www.youtube.com/embed/{v.get('key')}",
                "official": v.get("official", False),
                "language": v.get("iso_639_1"),
            })
    # Sort: official trailers first
    results.sort(key=lambda x: (not x["official"], x["type"] != "Trailer"))
    return results


def extract_cast(credits: dict, limit: int = 15) -> list[dict]:
    """Extract top cast members."""
    if not credits:
        return []
    cast = credits.get("cast") or []
    return [
        {
            "name":       c.get("name"),
            "character":  c.get("character"),
            "order":      c.get("order"),
            "profile_url": poster_url(c.get("profile_path"), "thumb"),
        }
        for c in cast[:limit]
        if c.get("name")
    ]


def extract_crew(credits: dict) -> dict:
    """Extract key crew (director, writer, producer, cinematographer)."""
    if not credits:
        return {}
    crew = credits.get("crew") or []
    result = {"directors": [], "writers": [], "producers": [], "cinematographers": []}
    for c in crew:
        job  = c.get("job", "").lower()
        dept = c.get("department", "").lower()
        name = c.get("name")
        if not name:
            continue
        if job == "director":
            result["directors"].append(name)
        elif job in ("writer", "screenplay", "story", "novel"):
            result["writers"].append(name)
        elif job == "producer":
            result["producers"].append(name)
        elif job == "director of photography":
            result["cinematographers"].append(name)
    return result


def extract_images(images: dict, poster_limit: int = 3, backdrop_limit: int = 3) -> dict:
    """Extract multiple poster and backdrop options."""
    if not images:
        return {}
    posters   = images.get("posters") or []
    backdrops = images.get("backdrops") or []
    return {
        "posters": [
            {
                "url":       poster_url(p.get("file_path"), "full"),
                "url_hd":    poster_url(p.get("file_path"), "hd"),
                "width":     p.get("width"),
                "height":    p.get("height"),
                "language":  p.get("iso_639_1"),
                "vote_avg":  p.get("vote_average"),
            }
            for p in posters[:poster_limit]
        ],
        "backdrops": [
            {
                "url":    backdrop_url(b.get("file_path"), "full"),
                "url_hd": backdrop_url(b.get("file_path"), "hd"),
                "width":  b.get("width"),
                "height": b.get("height"),
            }
            for b in backdrops[:backdrop_limit]
        ],
    }


def normalize_movie(details: dict) -> dict:
    """Flatten TMDb movie details into a clean enrichment dict."""
    credits  = details.get("credits") or {}
    videos   = details.get("videos") or {}
    images   = details.get("images") or {}
    keywords = details.get("keywords") or {}
    ext_ids  = details.get("external_ids") or {}

    poster_path   = details.get("poster_path")
    backdrop_path = details.get("backdrop_path")

    return {
        "tmdb_id":          details.get("id"),
        "imdb_id":          ext_ids.get("imdb_id") or details.get("imdb_id"),
        "title":            details.get("title"),
        "original_title":   details.get("original_title"),
        "tagline":          details.get("tagline"),
        "overview":         details.get("overview"),
        "year":             int(details["release_date"][:4]) if details.get("release_date") else None,
        "release_date":     details.get("release_date"),
        "runtime_mins":     details.get("runtime"),
        "status":           details.get("status"),
        "genres":           [g["name"] for g in (details.get("genres") or [])],
        "countries":        [c["name"] for c in (details.get("production_countries") or [])],
        "languages":        [l["english_name"] for l in (details.get("spoken_languages") or [])],
        "production_cos":   [c["name"] for c in (details.get("production_companies") or [])],
        "keywords":         [k["name"] for k in (keywords.get("keywords") or [])],
        "budget":           details.get("budget"),
        "revenue":          details.get("revenue"),
        "popularity":       details.get("popularity"),
        "vote_average":     details.get("vote_average"),
        "vote_count":       details.get("vote_count"),
        "adult":            details.get("adult", False),

        # Art
        "poster_url":       poster_url(poster_path, "card"),
        "poster_url_hd":    poster_url(poster_path, "hd"),
        "backdrop_url":     backdrop_url(backdrop_path, "full"),
        "backdrop_url_hd":  backdrop_url(backdrop_path, "hd"),
        "images":           extract_images(images),

        # People
        "cast":             extract_cast(credits),
        "crew":             extract_crew(credits),

        # Media
        "trailers":         extract_trailers(videos),
        "has_trailer":      any(v["type"] == "Trailer" for v in extract_trailers(videos)),
    }


def normalize_tv(details: dict) -> dict:
    """Flatten TMDb TV show details."""
    credits  = details.get("credits") or {}
    videos   = details.get("videos") or {}
    images   = details.get("images") or {}
    keywords = details.get("keywords") or {}
    ext_ids  = details.get("external_ids") or {}

    poster_path   = details.get("poster_path")
    backdrop_path = details.get("backdrop_path")

    first_air = details.get("first_air_date", "")

    return {
        "tmdb_id":          details.get("id"),
        "imdb_id":          ext_ids.get("imdb_id"),
        "title":            details.get("name"),
        "original_title":   details.get("original_name"),
        "tagline":          details.get("tagline"),
        "overview":         details.get("overview"),
        "year":             int(first_air[:4]) if first_air else None,
        "first_air_date":   first_air,
        "last_air_date":    details.get("last_air_date"),
        "status":           details.get("status"),
        "seasons":          details.get("number_of_seasons"),
        "episodes":         details.get("number_of_episodes"),
        "episode_runtime":  (details.get("episode_run_time") or [None])[0],
        "genres":           [g["name"] for g in (details.get("genres") or [])],
        "countries":        details.get("origin_country") or [],
        "languages":        [l["english_name"] for l in (details.get("spoken_languages") or [])],
        "networks":         [n["name"] for n in (details.get("networks") or [])],
        "production_cos":   [c["name"] for c in (details.get("production_companies") or [])],
        "keywords":         [k["name"] for k in ((keywords.get("results") or keywords.get("keywords")) or [])],
        "popularity":       details.get("popularity"),
        "vote_average":     details.get("vote_average"),
        "vote_count":       details.get("vote_count"),

        # Art
        "poster_url":       poster_url(poster_path, "card"),
        "poster_url_hd":    poster_url(poster_path, "hd"),
        "backdrop_url":     backdrop_url(backdrop_path, "full"),
        "backdrop_url_hd":  backdrop_url(backdrop_path, "hd"),
        "images":           extract_images(images),

        # People
        "cast":             extract_cast(credits),
        "crew":             extract_crew(credits),
        "created_by":       [c.get("name") for c in (details.get("created_by") or [])],

        # Media
        "trailers":         extract_trailers(videos),
        "has_trailer":      any(v["type"] == "Trailer" for v in extract_trailers(videos)),
    }


# ─── Enrichment pipeline ──────────────────────────────────────────────────────

def enrich_record(record: dict, delay: float = 0.25) -> dict:
    """
    Take a JustWatch record and enrich it with TMDb data.
    Returns the merged record.
    """
    title     = record.get("title", "")
    year      = record.get("year")
    media_type = record.get("type", "MOVIE")
    imdb_id   = record.get("imdb_id")

    tmdb_data = None

    # Strategy 1: Direct lookup by IMDb ID (most reliable)
    if imdb_id:
        search_type = "movie" if media_type == "MOVIE" else "tv"
        found = tmdb_get(f"/find/{imdb_id}", {"external_source": "imdb_id"})
        if found:
            results_key = "movie_results" if media_type == "MOVIE" else "tv_results"
            results = found.get(results_key) or []
            if results:
                tmdb_id = results[0]["id"]
                details = get_movie_details(tmdb_id) if media_type == "MOVIE" else get_tv_details(tmdb_id)
                if details:
                    tmdb_data = normalize_movie(details) if media_type == "MOVIE" else normalize_tv(details)

    # Strategy 2: Title + year search
    if not tmdb_data and title:
        match = find_tmdb_id(title, year, media_type)
        if match:
            tmdb_id = match["id"]
            time.sleep(delay)
            details = get_movie_details(tmdb_id) if media_type == "MOVIE" else get_tv_details(tmdb_id)
            if details:
                tmdb_data = normalize_movie(details) if media_type == "MOVIE" else normalize_tv(details)

    if tmdb_data:
        # Merge: TMDb data takes precedence for art/metadata,
        # but JustWatch data is authoritative for availability/pricing
        enriched = {**record, **tmdb_data}
        # Restore JustWatch availability (never overwrite with TMDb)
        enriched["availability"] = record.get("availability", {})
        enriched["jw_id"]        = record.get("jw_id")
        enriched["jw_url"]       = record.get("url")
        enriched["tmdb_matched"] = True
        enriched["enriched_at"]  = datetime.utcnow().isoformat()
    else:
        enriched = {
            **record,
            "tmdb_matched": False,
            "enriched_at": datetime.utcnow().isoformat(),
        }
        log.debug(f"No TMDb match for: {title} ({year})")

    time.sleep(delay)
    return enriched


def run_enrichment(
    input_path: str,
    output_path: str,
    delay: float = 0.25,
    limit: int = 0,
    skip_matched: bool = True,
) -> None:
    """
    Read JustWatch JSONL, enrich each record with TMDb, write enriched JSONL.

    Args:
        input_path:   Path to justwatch_catalog.jsonl
        output_path:  Path to write enriched_catalog.jsonl
        delay:        Seconds between TMDb API calls (free tier = 40 req/s, be safe)
        limit:        Max records to process (0 = all)
        skip_matched: Skip records already in output file (for resuming)
    """
    input_file = Path(input_path)
    if not input_file.exists():
        raise FileNotFoundError(f"Input file not found: {input_path}")

    # Load already-processed IDs if resuming
    already_done = set()
    if skip_matched and Path(output_path).exists():
        with open(output_path, "r") as f:
            for line in f:
                try:
                    r = json.loads(line)
                    if r.get("jw_id"):
                        already_done.add(r["jw_id"])
                except:
                    pass
        if already_done:
            log.info(f"Resuming — skipping {len(already_done):,} already-processed records")

    lines = input_file.read_text(encoding="utf-8").strip().splitlines()
    total = len(lines)
    log.info(f"Input: {total:,} records → {input_path}")
    log.info(f"Output → {output_path}")

    matched = 0
    processed = 0

    with open(output_path, "a", encoding="utf-8") as out:
        for i, line in enumerate(lines):
            try:
                record = json.loads(line.strip())
            except json.JSONDecodeError:
                continue

            # Skip if already processed
            if record.get("jw_id") in already_done:
                continue

            title = record.get("title", "?")
            year  = record.get("year", "")

            enriched = enrich_record(record, delay=delay)
            out.write(json.dumps(enriched, ensure_ascii=False) + "\n")
            out.flush()

            if enriched.get("tmdb_matched"):
                matched += 1

            processed += 1
            if processed % 50 == 0 or processed == 1:
                pct = 100 * (i + 1) / total
                log.info(f"  [{processed:,}/{total:,}] {pct:.1f}% — matched: {matched:,} — {title} ({year})")

            if limit and processed >= limit:
                log.info(f"Reached limit of {limit}. Stopping.")
                break

    log.info(f"\n✅ Done. {processed:,} processed, {matched:,} TMDb matches → {output_path}")


# ─── CLI ─────────────────────────────────────────────────────────────────────

def main():
    p = argparse.ArgumentParser(description="TMDb enrichment for JustWatch catalog")
    p.add_argument("--input",   default="justwatch_catalog.jsonl", help="Input JustWatch JSONL")
    p.add_argument("--output",  default="enriched_catalog.jsonl",  help="Output enriched JSONL")
    p.add_argument("--delay",   type=float, default=0.25,          help="Seconds between API calls")
    p.add_argument("--limit",   type=int,   default=0,             help="Max records (0=all)")
    p.add_argument("--no-resume", action="store_true",             help="Don't skip already-processed records")
    p.add_argument("--test",    action="store_true",               help="Test with 5 records")
    args = p.parse_args()

    # Validate API key before starting
    try:
        get_api_key()
    except ValueError as e:
        print(e)
        return

    if args.test:
        args.limit = 5
        log.info("Test mode: processing 5 records")

    run_enrichment(
        input_path=args.input,
        output_path=args.output,
        delay=args.delay,
        limit=args.limit,
        skip_matched=not args.no_resume,
    )


if __name__ == "__main__":
    main()
