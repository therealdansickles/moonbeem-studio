"""
Enrich Full Catalog (movies + TV) — Phase 3 of overnight scrape.
-----------------------------------------------------------------
Pulls every row from public.titles where enriched_at IS NULL and hits
TMDb /movie/{id} or /tv/{id} ?append_to_response=credits,external_ids.
Writes ONLY metadata fields; never touches is_active, is_featured, slug,
created_at. Idempotent — reruns continue from where they left off.

Run:
    cd scripts/scraper
    source .venv/bin/activate
    python enrich_full_catalog.py [--limit N] [--batch-size 100] [--rps 35]

Resume after a crash: just re-run the same command. The WHERE enriched_at
IS NULL filter naturally skips already-processed rows.

Logging: console + logs/enrich_YYYYMMDD_HHMM.log
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

try:
    import aiohttp
except ImportError:
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "aiohttp", "-q"])
    import aiohttp

import ssl

try:
    import certifi
except ImportError:
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "certifi", "-q"])
    import certifi

try:
    import asyncpg
except ImportError:
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "asyncpg", "-q"])
    import asyncpg

import datetime as _dt
import signal

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

TMDB_BASE = "https://api.themoviedb.org/3"
TMDB_IMG = "https://image.tmdb.org/t/p/w500"
DEFAULT_RPS = 35
DEFAULT_BATCH = 100
DEFAULT_PARALLEL = 2  # sub-batches processed concurrently per outer iteration
MAX_BACKOFF_RETRIES = 3

# Strict allow-list. The batched upsert path writes EXACTLY these columns
# per row (None for inapplicable, e.g. release_date on a TV row). NEVER:
# is_active, is_featured, slug (except for stubs being de-stubbed),
# created_at, distributor — those are curated.
ALLOWED_BATCH_KEYS = {
    "title",
    "overview",
    "poster_url",
    "popularity",
    "genres",
    "runtime_min",
    "production_companies",
    "cast_members",
    "crew",
    "release_date",
    "first_air_date",
    "last_air_date",
    "number_of_seasons",
    "number_of_episodes",
    "networks",
    "imdb_id",
}


def setup_logging() -> logging.Logger:
    Path("logs").mkdir(exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M")
    log_path = Path("logs") / f"enrich_{stamp}.log"
    fmt = logging.Formatter("%(asctime)s  %(levelname)s  %(message)s", "%H:%M:%S")
    log = logging.getLogger("enrich")
    log.setLevel(logging.INFO)
    fh = logging.FileHandler(log_path, encoding="utf-8")
    fh.setFormatter(fmt)
    log.addHandler(fh)
    sh = logging.StreamHandler()
    sh.setFormatter(fmt)
    log.addHandler(sh)
    log.info("log file: %s", log_path)
    return log


def env(name: str) -> str:
    v = os.environ.get(name)
    if not v:
        sys.stderr.write(f"Missing env var: {name}\n")
        sys.exit(1)
    return v


def slugify(text: str) -> str:
    text = (text or "").lower()
    text = re.sub(r"[^a-z0-9]+", "-", text).strip("-")
    return text[:80] or "untitled"


def slim_cast(cast_raw: list | None) -> list:
    out = []
    for c in cast_raw or []:
        out.append({
            "name": c.get("name"),
            "character": c.get("character"),
            "order": c.get("order"),
            "profile_path": c.get("profile_path"),
        })
    return out


def slim_crew(crew_raw: list | None) -> list:
    out = []
    for c in crew_raw or []:
        out.append({
            "name": c.get("name"),
            "job": c.get("job"),
            "department": c.get("department"),
            "profile_path": c.get("profile_path"),
        })
    return out


def slim_companies(items: list | None) -> list:
    out = []
    for it in items or []:
        out.append({
            "id": it.get("id"),
            "name": it.get("name"),
            "logo_path": it.get("logo_path"),
            "origin_country": it.get("origin_country"),
        })
    return out


def slim_genres(items: list | None) -> list:
    if not items:
        return []
    return [g.get("name") for g in items if g.get("name")]


def parse_year(date_str: str | None) -> int | None:
    if not date_str:
        return None
    try:
        return int(date_str[:4])
    except (ValueError, TypeError):
        return None


def build_movie_update(data: dict) -> dict:
    title = data.get("title") or data.get("original_title") or ""
    overview = data.get("overview")
    poster = data.get("poster_path")
    poster_url = f"{TMDB_IMG}{poster}" if poster else None
    update = {
        "title": title[:300],
        "original_title": data.get("original_title"),
        "tagline": data.get("tagline"),
        "overview": overview,
        "synopsis": overview,
        "poster_url": poster_url,
        "popularity": data.get("popularity"),
        "vote_average": data.get("vote_average"),
        "runtime_min": data.get("runtime"),
        "runtime_mins": data.get("runtime"),
        "genres": slim_genres(data.get("genres")),
        "production_companies": slim_companies(data.get("production_companies")),
        "release_date": data.get("release_date") or None,
        "year": parse_year(data.get("release_date")),
        "imdb_id": (data.get("external_ids") or {}).get("imdb_id"),
        "cast_members": slim_cast((data.get("credits") or {}).get("cast")),
        "crew": slim_crew((data.get("credits") or {}).get("crew")),
        "tmdb_matched": True,
    }
    if not update["release_date"]:
        update["release_date"] = None
    return update


def build_tv_update(data: dict) -> dict:
    title = data.get("name") or data.get("original_name") or ""
    overview = data.get("overview")
    poster = data.get("poster_path")
    poster_url = f"{TMDB_IMG}{poster}" if poster else None
    runtime_list = data.get("episode_run_time") or []
    runtime = runtime_list[0] if runtime_list else None
    update = {
        "title": title[:300],
        "original_title": data.get("original_name"),
        "tagline": data.get("tagline"),
        "overview": overview,
        "synopsis": overview,
        "poster_url": poster_url,
        "popularity": data.get("popularity"),
        "vote_average": data.get("vote_average"),
        "runtime_min": runtime,
        "runtime_mins": runtime,
        "genres": slim_genres(data.get("genres")),
        "networks": slim_companies(data.get("networks")),
        "production_companies": slim_companies(data.get("production_companies")),
        "first_air_date": data.get("first_air_date") or None,
        "last_air_date": data.get("last_air_date") or None,
        "year": parse_year(data.get("first_air_date")),
        "number_of_seasons": data.get("number_of_seasons"),
        "number_of_episodes": data.get("number_of_episodes"),
        "imdb_id": (data.get("external_ids") or {}).get("imdb_id"),
        "cast_members": slim_cast((data.get("credits") or {}).get("cast")),
        "crew": slim_crew((data.get("credits") or {}).get("crew")),
        "tmdb_matched": True,
    }
    return update


def looks_empty(update: dict) -> bool:
    return not update.get("poster_url") and not update.get("overview") and not (
        update.get("release_date") or update.get("first_air_date")
    )


class TokenBucket:
    """Simple rate limiter — block until a token is available."""

    def __init__(self, rps: float):
        self.rps = rps
        self.interval = 1.0 / rps
        self.next_at = 0.0
        self.lock = asyncio.Lock()

    async def acquire(self):
        async with self.lock:
            now = time.monotonic()
            if now < self.next_at:
                await asyncio.sleep(self.next_at - now)
                now = time.monotonic()
            self.next_at = max(now, self.next_at) + self.interval


async def fetch_one(
    session: aiohttp.ClientSession,
    bucket: TokenBucket,
    api_key: str,
    media_type: str,
    tmdb_id: int,
    log: logging.Logger,
) -> tuple[int | None, dict | None]:
    """Returns (status, data). status: 200 on success, 404, etc."""
    path = "movie" if media_type == "movie" else "tv"
    extras = "credits,external_ids,release_dates" if media_type == "movie" else "credits,external_ids,content_ratings"
    url = f"{TMDB_BASE}/{path}/{tmdb_id}"
    params = {"api_key": api_key, "append_to_response": extras}
    backoff = 1.0
    for attempt in range(MAX_BACKOFF_RETRIES + 1):
        await bucket.acquire()
        try:
            async with session.get(url, params=params, timeout=aiohttp.ClientTimeout(total=20)) as resp:
                if resp.status == 200:
                    return 200, await resp.json()
                if resp.status == 404:
                    return 404, None
                if resp.status == 429:
                    retry_after = float(resp.headers.get("retry-after", backoff))
                    log.warning("429 tmdb_id=%s retry_after=%.1f", tmdb_id, retry_after)
                    await asyncio.sleep(retry_after)
                    backoff *= 2
                    continue
                # Other 5xx
                log.warning("status=%s tmdb_id=%s body=%s", resp.status, tmdb_id, (await resp.text())[:200])
                if 500 <= resp.status < 600 and attempt < MAX_BACKOFF_RETRIES:
                    await asyncio.sleep(backoff)
                    backoff *= 2
                    continue
                return resp.status, None
        except (aiohttp.ClientError, asyncio.TimeoutError) as exc:
            log.warning("network err tmdb_id=%s: %s (attempt %d)", tmdb_id, exc, attempt + 1)
            if attempt < MAX_BACKOFF_RETRIES:
                await asyncio.sleep(backoff)
                backoff *= 2
                continue
            return None, None
    return None, None


async def fetch_batch_with_session(
    session: aiohttp.ClientSession,
    bucket: TokenBucket,
    api_key: str,
    rows: list[dict],
    log: logging.Logger,
) -> list[tuple[dict, int | None, dict | None]]:
    """Pipeline-friendly variant: takes a long-lived aiohttp session so
    we don't pay TLS handshake on every batch."""
    tasks = [
        fetch_one(session, bucket, api_key, row["media_type"], int(row["tmdb_id"]), log)
        for row in rows
    ]
    results = await asyncio.gather(*tasks, return_exceptions=False)
    return [(rows[i], status, data) for i, (status, data) in enumerate(results)]


async def fetch_batch(
    api_key: str,
    rows: list[dict],
    bucket: TokenBucket,
    log: logging.Logger,
) -> list[tuple[dict, int | None, dict | None]]:
    timeout = aiohttp.ClientTimeout(total=60)
    # macOS Pythons frequently lack a system CA path aiohttp can find. Pin
    # the trust store to certifi's bundle so SSL verification works without
    # disabling it.
    ssl_context = ssl.create_default_context(cafile=certifi.where())
    connector = aiohttp.TCPConnector(limit=100, ssl=ssl_context)
    async with aiohttp.ClientSession(timeout=timeout, connector=connector) as session:
        tasks = [
            fetch_one(session, bucket, api_key, row["media_type"], int(row["tmdb_id"]), log)
            for row in rows
        ]
        results = await asyncio.gather(*tasks, return_exceptions=False)
    return [(rows[i], status, data) for i, (status, data) in enumerate(results)]


def regenerate_slug_if_stub(row: dict, update: dict) -> dict | None:
    """If the stub slug is still in place, mint a real one from title+year.
    Returns None for non-stub rows (which keep their curated slug)."""
    current_slug = row.get("slug") or ""
    if not current_slug.startswith("tmdb-m-") and not current_slug.startswith("tmdb-t-"):
        return None
    title = update.get("title") or ""
    base = slugify(title)
    year = parse_year(update.get("release_date") or update.get("first_air_date"))
    candidate = f"{base}-{year}" if year else base
    return {"slug": candidate, "fallback": f"{base}-tmdb-{int(row['tmdb_id'])}"}


# Bulk write SQL — direct asyncpg path. Two variants:
#   non-stub: ON CONFLICT preserves slug (curated rows keep their slug)
#   stub:     ON CONFLICT overwrites slug (only for tmdb-{m|t}-{id} placeholders)
# Curated columns NEVER in SET: is_active, is_featured, distributor, created_at,
# slug (non-stub variant only), media_type. INSERT column list is required for
# NOT NULL satisfaction; the SET clause controls what UPDATE actually touches.

_INSERT_COLUMNS = (
    "id", "slug", "title", "media_type",
    "overview", "poster_url", "popularity",
    "genres", "runtime_min",
    "production_companies", "cast_members", "crew",
    "release_date", "first_air_date", "last_air_date",
    "number_of_seasons", "number_of_episodes", "networks",
    "enriched_at", "deleted", "imdb_id",
)

_SET_COLUMNS_NON_STUB = (
    "title", "overview", "poster_url", "popularity",
    "genres", "runtime_min",
    "production_companies", "cast_members", "crew",
    "release_date", "first_air_date", "last_air_date",
    "number_of_seasons", "number_of_episodes", "networks",
    "enriched_at", "deleted", "imdb_id",
)

# Stub variant adds slug to SET. Title also gets refreshed (placeholder
# 'TMDB:{id}' → real title).
_SET_COLUMNS_STUB = ("slug",) + _SET_COLUMNS_NON_STUB


def _build_multirow_upsert_sql(set_columns: tuple[str, ...], n_rows: int) -> str:
    """Build a single INSERT with n_rows VALUES tuples and the given SET
    clause. One round-trip for the whole batch (vs executemany which sends
    N EXECUTE messages — fast on local PG, slow over a pooler at ~70 ms RTT)."""
    n_cols = len(_INSERT_COLUMNS)
    insert_cols = ", ".join(_INSERT_COLUMNS)
    rows_sql = ", ".join(
        "(" + ", ".join(f"${i * n_cols + j + 1}" for j in range(n_cols)) + ")"
        for i in range(n_rows)
    )
    set_clause = ",\n      ".join(f"{c} = EXCLUDED.{c}" for c in set_columns)
    return (
        f"INSERT INTO public.titles ({insert_cols}) VALUES {rows_sql} "
        f"ON CONFLICT (id) DO UPDATE SET\n      {set_clause}"
    )


# Per-row fallback SQL kept for slug-collision recovery (still 1 round-trip each).
def _build_singlerow_upsert_sql(set_columns: tuple[str, ...]) -> str:
    return _build_multirow_upsert_sql(set_columns, 1)


SQL_UPSERT_NON_STUB_ONE = _build_singlerow_upsert_sql(_SET_COLUMNS_NON_STUB)
SQL_UPSERT_STUB_ONE = _build_singlerow_upsert_sql(_SET_COLUMNS_STUB)


def _parse_date(value) -> _dt.date | None:
    """asyncpg expects datetime.date for date columns, not strings."""
    if not value:
        return None
    if isinstance(value, _dt.date):
        return value
    try:
        return _dt.date.fromisoformat(str(value)[:10])
    except (ValueError, TypeError):
        return None


def build_row_tuple(row: dict, update: dict, slug_override: str | None, now: _dt.datetime) -> tuple:
    """Tuple in _INSERT_COLUMNS order. asyncpg native types: date for date
    columns, datetime for timestamptz, list[str] for text[], dict/list for
    jsonb (handled by the connection-level codec)."""
    return (
        row["id"],
        slug_override if slug_override is not None else row.get("slug"),
        update.get("title") or row.get("title") or "",
        row.get("media_type") or "movie",
        update.get("overview"),
        update.get("poster_url"),
        update.get("popularity"),
        update.get("genres") or [],
        update.get("runtime_min"),
        update.get("production_companies") or [],
        update.get("cast_members") or [],
        update.get("crew") or [],
        _parse_date(update.get("release_date")),
        _parse_date(update.get("first_air_date")),
        _parse_date(update.get("last_air_date")),
        update.get("number_of_seasons"),
        update.get("number_of_episodes"),
        update.get("networks") or [],
        now,
        False,  # deleted
        update.get("imdb_id"),
    )


async def _init_asyncpg_conn(conn) -> None:
    """Register a JSONB codec — without it asyncpg refuses dict/list for
    jsonb columns."""
    await conn.set_type_codec(
        "jsonb",
        encoder=json.dumps,
        decoder=json.loads,
        schema="pg_catalog",
    )
    await conn.set_type_codec(
        "json",
        encoder=json.dumps,
        decoder=json.loads,
        schema="pg_catalog",
    )


async def open_pool(database_url: str) -> "asyncpg.Pool":
    """Pool tuned for low concurrency, high-throughput batched writes.

    `statement_cache_size=0` is required if DATABASE_URL points at Supabase's
    transaction pooler (port 6543) — that pooler doesn't support prepared
    statements. Session pooler (port 5432) and direct connections work fine
    with the default cache. We auto-disable based on URL hints and respect
    PG_STATEMENT_CACHE_SIZE for manual override."""
    cache_override = os.environ.get("PG_STATEMENT_CACHE_SIZE")
    if cache_override is not None:
        cache_size = int(cache_override)
    elif ":6543" in database_url or "pgbouncer" in database_url.lower():
        cache_size = 0
    else:
        cache_size = 100
    return await asyncpg.create_pool(
        database_url,
        min_size=2,
        max_size=10,
        init=_init_asyncpg_conn,
        statement_cache_size=cache_size,
        command_timeout=60,
    )


async def apply_updates(
    sb: Client,
    pool: "asyncpg.Pool",
    batch_results: list[tuple[dict, int | None, dict | None]],
    log: logging.Logger,
) -> tuple[int, int, int]:
    """Bulk-write metadata via asyncpg executemany, with two SQL templates
    (stubs vs non-stubs) so curated slugs are preserved on non-stub rows
    while stub placeholders get rewritten.

    Markers (404 deletes, empty-data) stay on the PostgREST sync path —
    they're rare and a single-row UPDATE there is fine.

    Strict allow-list: SET clauses only touch metadata columns. is_active,
    is_featured, distributor, slug (non-stub), and media_type are NEVER in
    SET, so curated values survive every conflict resolution."""
    enriched = 0
    deleted = 0
    failed = 0
    now = datetime.now(timezone.utc)
    now_iso = now.isoformat()

    non_stub_tuples: list[tuple] = []
    stub_tuples: list[tuple[tuple, str, str]] = []  # (row_tuple, primary_slug, fallback_slug)

    for row, status, data in batch_results:
        try:
            if status == 404:
                sb.table("titles").update(
                    {"deleted": True, "enriched_at": now_iso}
                ).eq("id", row["id"]).execute()
                deleted += 1
                continue
            if status != 200 or data is None:
                failed += 1
                continue

            update = (
                build_movie_update(data)
                if row["media_type"] == "movie"
                else build_tv_update(data)
            )

            if looks_empty(update):
                sb.table("titles").update(
                    {"enriched_at": now_iso}
                ).eq("id", row["id"]).execute()
                enriched += 1
                continue

            slug_plan = regenerate_slug_if_stub(row, update)
            if slug_plan is None:
                non_stub_tuples.append(build_row_tuple(row, update, None, now))
            else:
                stub_tuples.append((
                    build_row_tuple(row, update, slug_plan["slug"], now),
                    slug_plan["slug"],
                    slug_plan["fallback"],
                ))
        except Exception as exc:
            log.exception("prep failed id=%s tmdb_id=%s: %s", row.get("id"), row.get("tmdb_id"), exc)
            failed += 1

    # Non-stub bulk write — single multi-row INSERT, one round-trip per batch.
    if non_stub_tuples:
        sql = _build_multirow_upsert_sql(_SET_COLUMNS_NON_STUB, len(non_stub_tuples))
        flat = [v for row in non_stub_tuples for v in row]
        try:
            async with pool.acquire() as conn:
                await conn.execute(sql, *flat)
            enriched += len(non_stub_tuples)
        except Exception as exc:
            log.exception("non-stub bulk insert failed (%d rows): %s", len(non_stub_tuples), exc)
            failed += len(non_stub_tuples)

    # Stub bulk write — try multi-row first; on slug collision (23505) fall
    # back to per-row writes so one bad slug doesn't kill the batch.
    if stub_tuples:
        bulk = [t[0] for t in stub_tuples]
        sql_bulk = _build_multirow_upsert_sql(_SET_COLUMNS_STUB, len(bulk))
        flat_bulk = [v for row in bulk for v in row]
        try:
            async with pool.acquire() as conn:
                await conn.execute(sql_bulk, *flat_bulk)
            enriched += len(bulk)
        except asyncpg.UniqueViolationError:
            log.warning(
                "stub batch hit slug collision; falling back to per-row with fallback slugs",
            )
            async with pool.acquire() as conn:
                for tup, primary_slug, fallback_slug in stub_tuples:
                    try:
                        await conn.execute(SQL_UPSERT_STUB_ONE, *tup)
                        enriched += 1
                    except asyncpg.UniqueViolationError:
                        retry = (tup[0], fallback_slug) + tup[2:]
                        try:
                            await conn.execute(SQL_UPSERT_STUB_ONE, *retry)
                            enriched += 1
                        except Exception as inner:
                            log.exception(
                                "stub fallback failed id=%s primary=%s fallback=%s: %s",
                                tup[0], primary_slug, fallback_slug, inner,
                            )
                            failed += 1
                    except Exception as inner:
                        log.exception("stub per-row failed id=%s: %s", tup[0], inner)
                        failed += 1
        except Exception as exc:
            log.exception("stub bulk insert failed (%d rows): %s", len(bulk), exc)
            failed += len(bulk)

    return enriched, deleted, failed


def fetch_unenriched_batch(sb: Client, limit: int) -> list[dict]:
    r = (
        sb.table("titles")
        .select("id, tmdb_id, slug, media_type")
        .is_("enriched_at", "null")
        .not_.is_("tmdb_id", "null")
        .order("tmdb_id")
        .limit(limit)
        .execute()
    )
    return r.data or []


def count_total_unenriched(sb: Client) -> int | None:
    """Best-effort estimate. Exact count over 1M+ rows hits Supabase's
    statement timeout, so use 'estimated' (pg_stat-based). Returns None
    if even the estimate fails — the script still works without a
    denominator, ETA just becomes '?'."""
    for mode in ("estimated", "planned"):
        try:
            r = (
                sb.table("titles")
                .select("id", count=mode)
                .is_("enriched_at", "null")
                .not_.is_("tmdb_id", "null")
                .limit(1)
                .execute()
            )
            return r.count or 0
        except Exception:
            continue
    return None


def fmt_eta(remaining: int, rate_per_sec: float) -> str:
    if rate_per_sec <= 0:
        return "?"
    sec = remaining / rate_per_sec
    h = int(sec // 3600)
    m = int((sec % 3600) // 60)
    return f"{h}h {m:02d}m"


async def run(args, log: logging.Logger) -> int:
    sb_url = env("SUPABASE_URL")
    sb_key = env("SUPABASE_SERVICE_ROLE_KEY")
    api_key = env("TMDB_API_KEY")
    database_url = env("DATABASE_URL")
    sb: Client = create_client(sb_url, sb_key)
    bucket = TokenBucket(args.rps)

    initial_remaining = count_total_unenriched(sb)
    log.info(
        "starting enrichment: ~%s rows pending (estimate), batch=%d, rps=%.1f, limit=%s",
        initial_remaining if initial_remaining is not None else "?",
        args.batch_size,
        args.rps,
        args.limit if args.limit else "none",
    )

    total_enriched = 0
    total_deleted = 0
    total_failed = 0
    t0 = time.monotonic()

    consecutive_dead_batches = 0
    DEAD_BATCH_LIMIT = 3  # bail if 3 batches in a row produce zero progress

    pool = await open_pool(database_url)
    log.info("asyncpg pool open (size 2-10, statement_cache_size auto)")

    # Cooperative cancellation on SIGINT/SIGTERM so the pool gets closed.
    stop_event = asyncio.Event()
    loop = asyncio.get_event_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop_event.set)
        except NotImplementedError:
            # Windows / some embedded environments don't support add_signal_handler.
            pass

    # Long-lived aiohttp session: shared across batches so we don't pay
    # the DNS + TLS handshake cost on every batch.
    ssl_context = ssl.create_default_context(cafile=certifi.where())
    connector = aiohttp.TCPConnector(limit=100, ssl=ssl_context)
    timeout = aiohttp.ClientTimeout(total=60)
    aio_session = aiohttp.ClientSession(timeout=timeout, connector=connector)

    log.info(
        "concurrency: %d sub-batches × %d rows = %d rows per outer iteration",
        args.parallel, args.batch_size, args.parallel * args.batch_size,
    )

    async def process_one(sub_rows: list[dict]) -> tuple[int, int, int]:
        sub_results = await fetch_batch_with_session(
            aio_session, bucket, api_key, sub_rows, log
        )
        return await apply_updates(sb, pool, sub_results, log)

    try:
        while True:
            if stop_event.is_set():
                log.warning("stop signal received; finishing in-flight batch and exiting")
                break
            if args.limit and total_enriched + total_deleted >= args.limit:
                log.info("--limit reached")
                break

            outer_target = args.parallel * args.batch_size
            if args.limit:
                outer_target = min(
                    outer_target, args.limit - (total_enriched + total_deleted)
                )
            if outer_target <= 0:
                break

            rows = fetch_unenriched_batch(sb, outer_target)
            if not rows:
                log.info("no more unenriched rows")
                break

            # Slice into N sub-batches; each runs (TMDb fetch + asyncpg write)
            # concurrently. Token bucket caps total TMDb rate at --rps.
            sub_batches = [
                rows[i : i + args.batch_size]
                for i in range(0, len(rows), args.batch_size)
            ]
            results = await asyncio.gather(*(process_one(sub) for sub in sub_batches))
            enriched = sum(r[0] for r in results)
            deleted = sum(r[1] for r in results)
            failed = sum(r[2] for r in results)

            total_enriched += enriched
            total_deleted += deleted
            total_failed += failed

            if enriched + deleted == 0:
                consecutive_dead_batches += 1
                if consecutive_dead_batches >= DEAD_BATCH_LIMIT:
                    log.error(
                        "%d consecutive batches with zero progress — aborting. "
                        "Check network / TMDb status / API key.",
                        consecutive_dead_batches,
                    )
                    break
            else:
                consecutive_dead_batches = 0

            done = total_enriched + total_deleted
            elapsed = time.monotonic() - t0
            rate = done / elapsed if elapsed > 0 else 0
            if initial_remaining is not None and initial_remaining > 0:
                remaining = max(0, initial_remaining - done)
                pct = 100.0 * done / initial_remaining
                eta = fmt_eta(remaining, rate)
                denom = f"/{initial_remaining}"
            else:
                pct = 0.0
                eta = "?"
                denom = "/?"
            log.info(
                "[iter] enriched=%d deleted=%d failed=%d | total_done=%d%s (%.2f%%) | rate=%.1f/s | ETA: %s",
                enriched, deleted, failed,
                done, denom, pct, rate, eta,
            )
    finally:
        await aio_session.close()
        await pool.close()
        log.info("asyncpg pool + aiohttp session closed")

    elapsed = time.monotonic() - t0
    log.info(
        "done: enriched=%d deleted=%d failed=%d in %.1fs (%.1f/s)",
        total_enriched, total_deleted, total_failed,
        elapsed, (total_enriched + total_deleted) / elapsed if elapsed else 0,
    )
    return 0 if total_failed == 0 else 2


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=None, help="Stop after N enrichments (dry run)")
    ap.add_argument("--batch-size", type=int, default=DEFAULT_BATCH, help="Rows per sub-batch")
    ap.add_argument("--parallel", type=int, default=DEFAULT_PARALLEL, help="Sub-batches processed concurrently per loop iteration")
    ap.add_argument("--rps", type=float, default=DEFAULT_RPS)
    args = ap.parse_args()
    log = setup_logging()
    return asyncio.run(run(args, log))


if __name__ == "__main__":
    sys.exit(main())
