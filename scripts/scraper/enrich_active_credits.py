"""
Enrich Active Title Credits
----------------------------
Calls TMDb /movie/{id}?append_to_response=credits for every active or
featured title in public.titles, then upserts cast_members + crew JSONB
plus enriched_at = now().

Run:
    cd scripts/scraper
    python enrich_active_credits.py

Requires (already in scripts/scraper/.env):
    SUPABASE_URL
    SUPABASE_SERVICE_ROLE_KEY  (service role bypasses RLS for the update)
    TMDB_API_KEY
"""

import os
import sys
import time
import logging
from datetime import datetime, timezone

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
log = logging.getLogger("credits")

TMDB_BASE = "https://api.themoviedb.org/3"
RATE_LIMIT_SECONDS = 0.25


def env(name: str) -> str:
    v = os.environ.get(name)
    if not v:
        log.error("Missing env var: %s", name)
        sys.exit(1)
    return v


def fetch_credits(tmdb_id: int, api_key: str) -> dict | None:
    url = f"{TMDB_BASE}/movie/{tmdb_id}"
    params = {"api_key": api_key, "append_to_response": "credits"}
    try:
        r = requests.get(url, params=params, timeout=15)
    except requests.RequestException as exc:
        log.warning("tmdb network error tmdb_id=%s: %s", tmdb_id, exc)
        return None
    if r.status_code != 200:
        log.warning("tmdb %s for tmdb_id=%s body=%s", r.status_code, tmdb_id, r.text[:200])
        return None
    return r.json()


def _search_once(title: str, year: int | None, api_key: str) -> list:
    params = {"api_key": api_key, "query": title}
    if year:
        params["primary_release_year"] = year
    try:
        r = requests.get(f"{TMDB_BASE}/search/movie", params=params, timeout=15)
    except requests.RequestException as exc:
        log.warning("tmdb search error title=%r: %s", title, exc)
        return []
    if r.status_code != 200:
        return []
    return (r.json() or {}).get("results") or []


def lookup_tmdb_id_by_title(title: str, year: int | None, api_key: str) -> int | None:
    """Fallback for hand-seeded rows with no tmdb_id. Tries /search/movie with
    primary_release_year first, then drops the year filter (festival vs.
    theatrical years often disagree). Picks the first match."""
    results = _search_once(title, year, api_key)
    if not results and year:
        results = _search_once(title, None, api_key)
    if not results:
        return None
    return int(results[0].get("id"))


def slim_cast(cast_raw: list) -> list:
    out = []
    for c in cast_raw or []:
        out.append({
            "name": c.get("name"),
            "character": c.get("character"),
            "order": c.get("order"),
            "profile_path": c.get("profile_path"),
        })
    return out


def slim_crew(crew_raw: list) -> list:
    out = []
    for c in crew_raw or []:
        out.append({
            "name": c.get("name"),
            "job": c.get("job"),
            "department": c.get("department"),
            "profile_path": c.get("profile_path"),
        })
    return out


def main() -> int:
    sb_url = env("SUPABASE_URL")
    sb_key = env("SUPABASE_SERVICE_ROLE_KEY")
    tmdb_key = env("TMDB_API_KEY")

    sb: Client = create_client(sb_url, sb_key)

    res = (
        sb.table("titles")
        .select("id, slug, title, year, tmdb_id, is_active, is_featured")
        .or_("is_active.eq.true,is_featured.eq.true")
        .execute()
    )
    rows = res.data or []
    log.info("Found %d active/featured titles", len(rows))

    enriched = 0
    skipped = 0
    failed = 0

    for row in rows:
        title = row.get("title") or row.get("slug")
        tmdb_id = row.get("tmdb_id")

        if not tmdb_id:
            looked_up = lookup_tmdb_id_by_title(title, row.get("year"), tmdb_key)
            time.sleep(RATE_LIMIT_SECONDS)
            if not looked_up:
                log.warning("skip no_tmdb_id title=%r year=%s", title, row.get("year"))
                skipped += 1
                continue
            log.info("looked up tmdb_id=%s for title=%r", looked_up, title)
            sb.table("titles").update({"tmdb_id": looked_up}).eq("id", row["id"]).execute()
            tmdb_id = looked_up

        try:
            data = fetch_credits(int(tmdb_id), tmdb_key)
            if not data or "credits" not in data:
                log.warning("no credits in response title=%r tmdb_id=%s", title, tmdb_id)
                failed += 1
                time.sleep(RATE_LIMIT_SECONDS)
                continue

            credits = data["credits"]
            cast_members = slim_cast(credits.get("cast", []))
            crew = slim_crew(credits.get("crew", []))

            update_res = (
                sb.table("titles")
                .update({
                    "cast_members": cast_members,
                    "crew": crew,
                    "enriched_at": datetime.now(timezone.utc).isoformat(),
                })
                .eq("id", row["id"])
                .execute()
            )
            if not update_res.data:
                log.warning("update returned no rows title=%r", title)
                failed += 1
            else:
                log.info(
                    "ok title=%r cast=%d crew=%d",
                    title,
                    len(cast_members),
                    len(crew),
                )
                enriched += 1
        except Exception as exc:
            log.exception("error title=%r tmdb_id=%s: %s", title, tmdb_id, exc)
            failed += 1
        finally:
            time.sleep(RATE_LIMIT_SECONDS)

    log.info(
        "Done. enriched=%d skipped=%d failed=%d total=%d",
        enriched,
        skipped,
        failed,
        len(rows),
    )
    return 0 if failed == 0 else 2


if __name__ == "__main__":
    sys.exit(main())
