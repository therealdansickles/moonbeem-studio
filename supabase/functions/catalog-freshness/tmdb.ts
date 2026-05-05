// TMDb HTTP client for the catalog-freshness Edge Function.
//
// Two endpoints used (v1 = changes-feed only):
//   GET /{movie|tv}/changes?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD&page=N
//   GET /{movie|tv}/{id}?append_to_response=credits,external_ids,images,videos,keywords
//
// Auth: api_key query param (TMDb v3 style). Matches the existing
// scraper at scripts/scraper/enrich_full_catalog.py — same key works.
//
// Rate limiting: 35 req/s self-throttle via a token bucket. This is
// our conservative ceiling carried over from the prior scrape, NOT
// TMDb's published limit. TMDb soft-enforces ~50 req/s per IP; we
// stay under to leave headroom for any other concurrent caller on
// the same Edge Function IP and to absorb burstiness.
//
// Error handling:
//   - 401  -> throw TmdbAuthError (caller stops the entire run)
//   - 404  -> fetchTitleDetails returns null (caller counts as
//             failed and continues); fetchChangesPage shouldn't see
//             404 in practice but is treated as empty results
//   - 429  -> respect Retry-After header, retry up to MAX_RETRIES
//   - 5xx  -> exponential backoff, retry up to MAX_RETRIES
//   - other 4xx -> throw, caller logs and continues per-title
//
// Pagination ordering: TMDb's /changes endpoint does NOT document
// any ordering guarantee for results within a page. The skip-forward
// logic in index.ts (current_page_last_id_processed) assumes
// monotonic-ascending ids. If TMDb starts returning out-of-order
// pages we emit a console.warn line ("PAGINATION_ORDER_DRIFT ...")
// so we can switch to ordinal-based cursoring before the next
// invocation. Re-processing on a partial-resume is idempotent
// (upsert), so a brief drift period is harmless even before the
// switch.

const TMDB_BASE = "https://api.themoviedb.org/3";

// /changes returns 100 ids per page by default; we don't page-size
// override. Detail responses with append_to_response are ~50-200kB.
const DETAILS_APPEND = "credits,external_ids,images,videos,keywords";

const SELF_THROTTLE_RPS = 35;
const MAX_RETRIES = 5;
const MAX_BACKOFF_MS = 30_000;

export class TmdbAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TmdbAuthError";
  }
}

// Single-process token bucket. Deno is single-threaded so concurrent
// acquire() calls serialize via the await chain — no lock needed.
class TokenBucket {
  private nextAt = 0;
  private readonly intervalMs: number;
  constructor(rps: number) {
    this.intervalMs = 1000 / rps;
  }
  async acquire(): Promise<void> {
    const now = Date.now();
    const wait = Math.max(0, this.nextAt - now);
    if (wait > 0) {
      await sleep(wait);
    }
    this.nextAt = Math.max(now, this.nextAt) + this.intervalMs;
  }
}

const bucket = new TokenBucket(SELF_THROTTLE_RPS);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfter(res: Response): number {
  const raw = res.headers.get("retry-after");
  if (!raw) return 1000;
  const asNum = Number(raw);
  if (Number.isFinite(asNum) && asNum > 0) {
    return Math.min(asNum * 1000, MAX_BACKOFF_MS);
  }
  // Retry-After can also be an HTTP-date; fall back to 1s.
  return 1000;
}

function backoffMs(attempt: number): number {
  return Math.min(500 * Math.pow(2, attempt), MAX_BACKOFF_MS);
}

async function tmdbFetch(url: string): Promise<Response> {
  let attempt = 0;
  while (true) {
    await bucket.acquire();
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { Accept: "application/json" },
      });
    } catch (err) {
      if (attempt >= MAX_RETRIES) throw err;
      await sleep(backoffMs(attempt));
      attempt++;
      continue;
    }

    if (res.ok) return res;

    if (res.status === 401) {
      throw new TmdbAuthError(
        `TMDb returned 401 at ${redactKey(url)}`,
      );
    }
    if (res.status === 404) return res;
    if (res.status === 429) {
      if (attempt >= MAX_RETRIES) {
        throw new Error(
          `TMDb 429 after ${MAX_RETRIES} retries at ${redactKey(url)}`,
        );
      }
      const wait = parseRetryAfter(res);
      console.warn(
        `[catalog-freshness] TMDB_RATE_LIMIT attempt=${attempt} wait_ms=${wait}`,
      );
      await sleep(wait);
      attempt++;
      continue;
    }
    if (res.status >= 500) {
      if (attempt >= MAX_RETRIES) {
        throw new Error(
          `TMDb ${res.status} after ${MAX_RETRIES} retries at ${
            redactKey(url)
          }`,
        );
      }
      const wait = backoffMs(attempt);
      console.warn(
        `[catalog-freshness] TMDB_5XX status=${res.status} attempt=${attempt} wait_ms=${wait}`,
      );
      await sleep(wait);
      attempt++;
      continue;
    }

    // Other 4xx: surface to caller, don't retry.
    const body = await res.text().catch(() => "");
    throw new Error(
      `TMDb ${res.status} at ${redactKey(url)}: ${body.slice(0, 300)}`,
    );
  }
}

function redactKey(url: string): string {
  return url.replace(/api_key=[^&]+/g, "api_key=REDACTED");
}

function buildUrl(path: string, params: Record<string, string>): string {
  const u = new URL(`${TMDB_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    u.searchParams.set(k, v);
  }
  return u.toString();
}

// ---------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------

export type ChangesPageResult = {
  results: { id: number }[];
  page: number;
  total_pages: number;
  total_results: number;
};

export type FetchChangesPageArgs = {
  tmdbApiKey: string;
  mediaType: "movie" | "tv";
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  page: number;
};

export async function fetchChangesPage(
  args: FetchChangesPageArgs,
): Promise<ChangesPageResult> {
  const url = buildUrl(`/${args.mediaType}/changes`, {
    api_key: args.tmdbApiKey,
    start_date: args.startDate,
    end_date: args.endDate,
    page: String(args.page),
  });
  const res = await tmdbFetch(url);
  if (res.status === 404) {
    return { results: [], page: args.page, total_pages: 0, total_results: 0 };
  }
  const json = (await res.json()) as ChangesPageResult;

  // Defensive: warn (don't throw) if pagination is non-monotonic.
  // index.ts's resume cursor assumes monotonic-ascending ids; if
  // TMDb starts returning shuffled pages this surfaces it without a
  // behavior change. Re-processing on resume is idempotent so the
  // warning is purely diagnostic until we decide to switch cursors.
  if (json.results && json.results.length > 1) {
    let monotonic = true;
    for (let i = 1; i < json.results.length; i++) {
      if (json.results[i].id < json.results[i - 1].id) {
        monotonic = false;
        break;
      }
    }
    if (!monotonic) {
      const firstId = json.results[0].id;
      const lastId = json.results[json.results.length - 1].id;
      console.warn(
        `[catalog-freshness] PAGINATION_ORDER_DRIFT page=${args.page} media_type=${args.mediaType} first_id=${firstId} last_id=${lastId} non_monotonic=true`,
      );
    }
  }

  return json;
}

export type FetchTitleDetailsArgs = {
  tmdbApiKey: string;
  mediaType: "movie" | "tv";
  tmdbId: number;
};

// Returns null on 404 (deleted/private/adult title that no longer
// resolves). Returns the raw TMDb details object otherwise — shape
// transformation lives in upsert.ts.
export async function fetchTitleDetails(
  args: FetchTitleDetailsArgs,
): Promise<Record<string, unknown> | null> {
  const url = buildUrl(`/${args.mediaType}/${args.tmdbId}`, {
    api_key: args.tmdbApiKey,
    append_to_response: DETAILS_APPEND,
  });
  const res = await tmdbFetch(url);
  if (res.status === 404) return null;
  return (await res.json()) as Record<string, unknown>;
}
