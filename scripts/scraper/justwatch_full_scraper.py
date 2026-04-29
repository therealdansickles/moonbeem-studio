"""
JustWatch Full Catalog Scraper
-------------------------------
Pulls ALL titles (movies + series) from JustWatch including:
  - Poster images (full CDN URLs, ready to display)
  - Backdrop/hero images
  - Streaming availability (every platform)
  - TVOD rental & purchase prices
  - IMDb / TMDB scores
  - Genres, runtime, cast, description

Output: a JSONL file (one JSON record per line) + a summary JSON
These feed directly into catalog_viewer.html for browsing.

Usage:
    python justwatch_full_scraper.py                          # All US titles
    python justwatch_full_scraper.py --country GB             # UK catalog
    python justwatch_full_scraper.py --max 500                # Quick sample
    python justwatch_full_scraper.py --movies-only            # Movies only
    python justwatch_full_scraper.py --output my_catalog.jsonl

Requirements:
    pip install requests
"""

import json
import time
import argparse
import logging
import sys
from datetime import datetime
from pathlib import Path

try:
    import requests
except ImportError:
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "requests", "-q"])
    import requests

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(message)s",
    datefmt="%H:%M:%S"
)
log = logging.getLogger("jw")

# ─── Config ──────────────────────────────────────────────────────────────────

GRAPHQL_URL = "https://apis.justwatch.com/graphql"

HEADERS = {
    "Content-Type": "application/json",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Origin": "https://www.justwatch.com",
    "Referer": "https://www.justwatch.com/",
    "Accept": "application/json",
    "Accept-Language": "en-US,en;q=0.9",
}

COUNTRY_LOCALES = {
    "US": "en_US", "GB": "en_GB", "CA": "en_CA",
    "AU": "en_AU", "DE": "de_DE", "FR": "fr_FR",
    "NL": "nl_NL", "IT": "it_IT", "ES": "es_ES",
}

# JustWatch image CDN — sizes: s166, s276, s592, s1080
JW_IMAGE_BASE = "https://images.justwatch.com"

# ─── GraphQL Query ────────────────────────────────────────────────────────────

FULL_TITLES_QUERY = """
query GetAllTitles(
  $country: Country!
  $language: Language!
  $first: Int!
  $after: String
  $objectTypes: [ObjectType!]
) {
  popularTitles(
    country: $country
    filter: { objectTypes: $objectTypes }
    first: $first
    after: $after
  ) {
    totalCount
    pageInfo {
      hasNextPage
      endCursor
    }
    edges {
      node {
        id
        objectType
        content(country: $country, language: $language) {
          title
          fullPath
          originalTitle
          originalReleaseYear
          shortDescription
          runtime
          productionCountries
          posterUrl
          backdrops {
            backdropUrl
          }
          genres {
            shortName
            translation
          }
          credits(role: ACTOR, first: 5) {
            name
          }
          externalIds {
            imdbId
          }
          scoring {
            imdbScore
            imdbVotes
            tmdbPopularity
            tmdbScore
          }
          upcomingReleases(releaseTypes: DIGITAL) {
            releaseDate
            label
            package { clearName }
          }
        }
        offers(country: $country, platform: WEB) {
          monetizationType
          presentationType
          standardWebURL
          retailPrice(language: $language) {
            amount
            currency
          }
          package {
            id
            packageId
            clearName
            shortName
            technicalName
            icon
            iconUrl
          }
        }
        watchNowOffer(country: $country, platform: WEB) {
          monetizationType
          standardWebURL
          package { clearName technicalName iconUrl }
        }
      }
    }
  }
}
"""

# ─── Image URL helpers ────────────────────────────────────────────────────────

def make_poster_url(path: str | None, size: str = "s276") -> str | None:
    """Build a full poster URL from a JustWatch poster path."""
    if not path:
        return None
    if path.startswith("http"):
        return path
    # JustWatch paths look like: /poster/123456789/s{size}/poster.jpg
    # The API returns them with {format} placeholder
    path = path.replace("{format}", "webp")
    if path.startswith("/"):
        return f"{JW_IMAGE_BASE}{path}".replace("{profile}", size)
    return f"{JW_IMAGE_BASE}/{path}".replace("{profile}", size)


def make_backdrop_url(path: str | None, size: str = "s1080") -> str | None:
    """Build a full backdrop URL."""
    if not path:
        return None
    if path.startswith("http"):
        return path
    path = path.replace("{format}", "webp")
    if path.startswith("/"):
        return f"{JW_IMAGE_BASE}{path}".replace("{profile}", size)
    return f"{JW_IMAGE_BASE}/{path}".replace("{profile}", size)


# ─── Data normalization ───────────────────────────────────────────────────────

def parse_offers(offers: list) -> dict:
    """Categorize and deduplicate offers into streaming / rent / buy."""
    streaming, rent, buy = [], [], []
    seen_streaming, seen_rent, seen_buy = set(), set(), set()

    for offer in (offers or []):
        m = offer.get("monetizationType", "")
        pkg = offer.get("package") or {}
        pid = pkg.get("technicalName", "")
        platform = pkg.get("clearName", "Unknown")
        quality = offer.get("presentationType", "")
        url = offer.get("standardWebURL", "")
        price_info = offer.get("retailPrice") or {}
        price = price_info.get("amount")
        currency = price_info.get("currency", "USD")
        icon = pkg.get("iconUrl") or pkg.get("icon")
        if icon and not icon.startswith("http"):
            icon = f"{JW_IMAGE_BASE}{icon}"

        base = {
            "platform": platform,
            "platform_id": pid,
            "quality": quality,
            "url": url,
            "icon": icon,
        }

        if m in ("FLATRATE", "FREE", "ADS", "FLATRATE_AND_BUY"):
            key = pid
            if key not in seen_streaming:
                seen_streaming.add(key)
                streaming.append({**base, "type": m.lower()})
        if m in ("RENT", "FLATRATE_AND_BUY"):
            key = f"{pid}_{quality}"
            if key not in seen_rent and price:
                seen_rent.add(key)
                rent.append({**base, "price": price, "currency": currency})
        if m in ("BUY", "FLATRATE_AND_BUY"):
            key = f"{pid}_{quality}"
            if key not in seen_buy and price:
                seen_buy.add(key)
                buy.append({**base, "price": price, "currency": currency})

    # Sort rent/buy by price
    rent.sort(key=lambda x: x.get("price") or 999)
    buy.sort(key=lambda x: x.get("price") or 999)

    return {"streaming": streaming, "rent": rent, "buy": buy}


def normalize(node: dict, country: str, language: str) -> dict:
    """Flatten a JustWatch API node into a clean, UI-ready record."""
    content = node.get("content") or {}
    scoring = content.get("scoring") or {}
    offers = parse_offers(node.get("offers") or [])
    backdrops = content.get("backdrops") or []
    ext_ids = content.get("externalIds") or {}
    credits = content.get("credits") or []

    rent_prices  = [o["price"] for o in offers["rent"]]
    buy_prices   = [o["price"] for o in offers["buy"]]
    streaming_names = [o["platform"] for o in offers["streaming"]]

    poster_raw = content.get("posterUrl")
    backdrop_raw = backdrops[0].get("backdropUrl") if backdrops else None

    upcoming = content.get("upcomingReleases") or []
    upcoming_clean = [
        {
            "date": u.get("releaseDate"),
            "label": u.get("label"),
            "platform": (u.get("package") or {}).get("clearName"),
        }
        for u in upcoming
    ]

    return {
        # Identity
        "jw_id":        node.get("id"),
        "type":         node.get("objectType", "MOVIE"),   # MOVIE or SHOW
        "title":        content.get("title"),
        "original_title": content.get("originalTitle"),
        "year":         content.get("originalReleaseYear"),
        "imdb_id":      ext_ids.get("imdbId"),
        "url":          f"https://www.justwatch.com{content.get('fullPath', '')}",

        # Art / images
        "poster_url":   make_poster_url(poster_raw, "s276"),
        "poster_large": make_poster_url(poster_raw, "s592"),
        "backdrop_url": make_backdrop_url(backdrop_raw, "s1080"),

        # Metadata
        "description":  content.get("shortDescription"),
        "runtime_mins": content.get("runtime"),
        "genres":       [g.get("translation") for g in content.get("genres") or []],
        "countries":    content.get("productionCountries") or [],
        "cast":         [c.get("name") for c in credits if c.get("name")],

        # Scores
        "scores": {
            "imdb":            scoring.get("imdbScore"),
            "imdb_votes":      scoring.get("imdbVotes"),
            "tmdb":            scoring.get("tmdbScore"),
            "tmdb_popularity": scoring.get("tmdbPopularity"),
        },

        # Availability
        "availability": {
            "country":           country,
            "streaming":         offers["streaming"],
            "rent":              offers["rent"],
            "buy":               offers["buy"],
            "streaming_names":   streaming_names,
            "cheapest_rent":     min(rent_prices)  if rent_prices  else None,
            "cheapest_buy":      min(buy_prices)   if buy_prices   else None,
            "is_streaming":      len(offers["streaming"]) > 0,
            "is_tvod":           len(rent_prices) > 0 or len(buy_prices) > 0,
            "platform_count":    len(set(streaming_names)),
            "upcoming":          upcoming_clean,
        },

        "scraped_at": datetime.utcnow().isoformat(),
    }


# ─── API request ──────────────────────────────────────────────────────────────

def gql(query: str, variables: dict, retries: int = 4) -> dict | None:
    for attempt in range(retries):
        try:
            r = requests.post(
                GRAPHQL_URL,
                json={"query": query, "variables": variables},
                headers=HEADERS,
                timeout=30,
            )
            r.raise_for_status()
            data = r.json()
            if "errors" in data:
                log.warning(f"GQL errors: {data['errors']}")
            return data.get("data")
        except requests.RequestException as e:
            wait = 2 ** attempt
            log.warning(f"Attempt {attempt+1}/{retries} failed: {e}. Retrying in {wait}s…")
            time.sleep(wait)
    return None


# ─── Main crawl ───────────────────────────────────────────────────────────────

def crawl(
    country: str = "US",
    max_titles: int = 0,
    page_size: int = 50,
    object_types: list = None,
    output_path: str = "justwatch_catalog.jsonl",
    delay: float = 0.4,
) -> list[dict]:
    """
    Crawl the full JustWatch catalog and write results to a JSONL file.

    Args:
        country:      ISO country code
        max_titles:   0 = no limit (full catalog)
        page_size:    records per API call (max ~100 before rate limiting)
        object_types: ["MOVIE", "SHOW"] or a subset
        output_path:  where to write JSONL output
        delay:        seconds between requests (be polite)
    """
    if object_types is None:
        object_types = ["MOVIE", "SHOW"]

    language = COUNTRY_LOCALES.get(country, "en_US")
    cursor = None
    total_fetched = 0
    total_available = None
    results = []

    log.info(f"Starting JustWatch crawl — country={country}, types={object_types}")
    log.info(f"Output → {output_path}")

    out = open(output_path, "w", encoding="utf-8")

    try:
        while True:
            variables = {
                "country": country,
                "language": language,
                "first": page_size,
                "objectTypes": object_types,
            }
            if cursor:
                variables["after"] = cursor

            data = gql(FULL_TITLES_QUERY, variables)
            if not data:
                log.error("Empty API response — stopping.")
                break

            popular = data.get("popularTitles", {})

            if total_available is None:
                total_available = popular.get("totalCount", "?")
                log.info(f"Total titles in JustWatch {country}: {total_available:,}" if isinstance(total_available, int) else f"Total: {total_available}")

            edges = popular.get("edges") or []
            if not edges:
                log.info("No more edges — done.")
                break

            for edge in edges:
                node = edge.get("node") or {}
                record = normalize(node, country, language)
                results.append(record)
                out.write(json.dumps(record, ensure_ascii=False) + "\n")

            out.flush()
            total_fetched += len(edges)

            page_info = popular.get("pageInfo", {})
            cursor = page_info.get("endCursor")

            pct = f"{100*total_fetched/total_available:.1f}%" if isinstance(total_available, int) and total_available else ""
            log.info(f"  Fetched {total_fetched:,} / {total_available} {pct}")

            if max_titles and total_fetched >= max_titles:
                log.info(f"Reached limit of {max_titles}. Stopping.")
                break

            if not page_info.get("hasNextPage"):
                log.info("Last page reached.")
                break

            time.sleep(delay)

    finally:
        out.close()

    log.info(f"\n✅ Done. {len(results):,} records → {output_path}")
    return results


# ─── Summary ─────────────────────────────────────────────────────────────────

def write_summary(results: list[dict], path: str):
    platforms = {}
    tvod_platforms = {}
    rent_prices, buy_prices = [], []
    genres = {}
    years = []
    has_poster = 0

    for r in results:
        avail = r.get("availability", {})
        if r.get("poster_url"):
            has_poster += 1
        if r.get("year"):
            years.append(r["year"])
        for g in (r.get("genres") or []):
            genres[g] = genres.get(g, 0) + 1
        for p in avail.get("streaming_names", []):
            platforms[p] = platforms.get(p, 0) + 1
        for item in avail.get("rent", []):
            tvod_platforms[item["platform"]] = tvod_platforms.get(item["platform"], 0) + 1
            if item.get("price"):
                rent_prices.append(item["price"])
        for item in avail.get("buy", []):
            if item.get("price"):
                buy_prices.append(item["price"])

    summary = {
        "total_titles":      len(results),
        "movies":            sum(1 for r in results if r.get("type") == "MOVIE"),
        "shows":             sum(1 for r in results if r.get("type") == "SHOW"),
        "with_poster":       has_poster,
        "streaming":         sum(1 for r in results if r["availability"].get("is_streaming")),
        "tvod_available":    sum(1 for r in results if r["availability"].get("is_tvod")),
        "not_available":     sum(1 for r in results if not r["availability"].get("is_streaming") and not r["availability"].get("is_tvod")),
        "top_platforms":     sorted(platforms.items(), key=lambda x: -x[1])[:15],
        "top_tvod_platforms":sorted(tvod_platforms.items(), key=lambda x: -x[1])[:10],
        "top_genres":        sorted(genres.items(), key=lambda x: -x[1])[:15],
        "year_range":        [min(years), max(years)] if years else None,
        "tvod_pricing":      {
            "avg_rent": round(sum(rent_prices)/len(rent_prices), 2) if rent_prices else None,
            "min_rent": min(rent_prices) if rent_prices else None,
            "max_rent": max(rent_prices) if rent_prices else None,
            "avg_buy":  round(sum(buy_prices)/len(buy_prices), 2) if buy_prices else None,
        },
        "scraped_at": datetime.utcnow().isoformat(),
    }

    with open(path, "w") as f:
        json.dump(summary, f, indent=2)

    log.info(f"Summary → {path}")
    print("\n" + "="*50)
    print(f"  Total titles:    {summary['total_titles']:,}")
    print(f"  Movies:          {summary['movies']:,}")
    print(f"  Shows:           {summary['shows']:,}")
    print(f"  With poster art: {summary['with_poster']:,}")
    print(f"  On streaming:    {summary['streaming']:,}")
    print(f"  TVOD available:  {summary['tvod_available']:,}")
    print(f"\n  Top platforms:")
    for name, count in summary["top_platforms"][:8]:
        print(f"    {name}: {count:,}")
    print("="*50 + "\n")

    return summary


# ─── CLI ─────────────────────────────────────────────────────────────────────

def main():
    p = argparse.ArgumentParser(description="JustWatch full catalog scraper with posters")
    p.add_argument("--country",      default="US",  choices=list(COUNTRY_LOCALES.keys()))
    p.add_argument("--max",          type=int, default=0,    help="Max titles (0=all)")
    p.add_argument("--page-size",    type=int, default=50)
    p.add_argument("--movies-only",  action="store_true")
    p.add_argument("--shows-only",   action="store_true")
    p.add_argument("--output",       default="justwatch_catalog.jsonl")
    p.add_argument("--delay",        type=float, default=0.4, help="Seconds between requests")
    args = p.parse_args()

    if args.movies_only:
        types = ["MOVIE"]
    elif args.shows_only:
        types = ["SHOW"]
    else:
        types = ["MOVIE", "SHOW"]

    results = crawl(
        country=args.country,
        max_titles=args.max,
        page_size=args.page_size,
        object_types=types,
        output_path=args.output,
        delay=args.delay,
    )

    summary_path = args.output.replace(".jsonl", "_summary.json")
    write_summary(results, summary_path)


if __name__ == "__main__":
    main()
