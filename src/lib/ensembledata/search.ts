// EnsembleData TikTok keyword-search wrapper for the Discover tab.
//
// Kept in src/lib/ensembledata/ alongside the existing client.ts
// (post-info, used by view-tracking). Single new public function:
//
//   searchTikTokKeyword({ query, max_results, period })
//     → { candidates, units_estimated, pages_fetched }
//
// EnsembleData's TikTok keyword search endpoint returns ~20 results
// per page; pagination is via cursor. We page until we have at least
// max_results candidates or the API signals has_more=false.
//
// Response field-mapping is BEST EFFORT against EnsembleData's
// documented shape — the same "verify on first prod call" caveat as
// client.ts (see the inline reference cases there). The fields below
// map the shape we observe in the existing /tt/post/info responses;
// keyword search nests one level deeper (data.aweme_list[].statistics.*
// vs the post-info data[].statistics.*) but the per-aweme inner shape
// is the same. If the field paths drift, fix here AND mirror in
// client.ts where applicable.

const ENSEMBLEDATA_BASE = "https://ensembledata.com/apis";
const FETCH_TIMEOUT_MS = 15000;
const RESULTS_PER_PAGE = 20;

export type SearchPeriod = "1d" | "7d" | "30d" | "90d" | "180d" | "all";

// EnsembleData period encoding: integer days, 0 = all-time.
const PERIOD_TO_DAYS: Record<SearchPeriod, number> = {
  "1d": 1,
  "7d": 7,
  "30d": 30,
  "90d": 90,
  "180d": 180,
  all: 0,
};

export type Candidate = {
  post_id: string; // numeric aweme id
  post_url: string; // canonical https://www.tiktok.com/@user/video/<id>
  handle: string; // @-stripped, lowercased
  caption: string | null;
  view_count: number | null;
  like_count: number | null;
  comment_count: number | null;
  share_count: number | null;
  thumbnail_url: string | null;
  posted_at: string | null; // ISO
  duration_seconds: number | null;
  aspect_ratio: string | null;
  hashtags: string[];
  is_video: boolean; // false for image-only / slideshow
};

export type SearchResult = {
  candidates: Candidate[];
  units_estimated: number; // 1 per page on Wood plan; we count pages
  pages_fetched: number;
  error?:
    | "missing_token"
    | "rate_limited"
    | "transient"
    | "parse_error"
    | "not_found";
};

export async function searchTikTokKeyword(args: {
  query: string;
  max_results: number;
  period: SearchPeriod;
}): Promise<SearchResult> {
  const token = process.env.ENSEMBLEDATA_TOKEN;
  if (!token) {
    return {
      candidates: [],
      units_estimated: 0,
      pages_fetched: 0,
      error: "missing_token",
    };
  }
  const days = PERIOD_TO_DAYS[args.period] ?? 180;
  const wanted = Math.max(1, Math.min(args.max_results, 100));

  const candidates: Candidate[] = [];
  const seenIds = new Set<string>();
  let cursor: number | string | null = 0;
  let pages = 0;
  let lastError: SearchResult["error"];

  while (candidates.length < wanted && pages < 10) {
    const url = new URL(`${ENSEMBLEDATA_BASE}/tt/keyword/search`);
    url.searchParams.set("name", args.query);
    url.searchParams.set("period", String(days));
    url.searchParams.set("token", token);
    if (cursor !== null && cursor !== 0) {
      url.searchParams.set("cursor", String(cursor));
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url.toString(), { signal: ctrl.signal });
    } catch {
      clearTimeout(timer);
      lastError = "transient";
      break;
    }
    clearTimeout(timer);
    pages += 1;

    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }

    if (res.status === 429) {
      lastError = "rate_limited";
      break;
    }
    if (res.status === 404) {
      lastError = "not_found";
      break;
    }
    if (res.status >= 500 || !res.ok) {
      lastError = "transient";
      break;
    }

    const page = parsePage(body);
    if (!page) {
      lastError = "parse_error";
      break;
    }
    for (const c of page.candidates) {
      if (seenIds.has(c.post_id)) continue;
      seenIds.add(c.post_id);
      candidates.push(c);
      if (candidates.length >= wanted) break;
    }
    if (page.cursor === null || page.has_more === false) break;
    cursor = page.cursor;
  }

  return {
    candidates: candidates.slice(0, wanted),
    units_estimated: pages, // 1 unit per page on Wood plan
    pages_fetched: pages,
    error: lastError,
  };
}

// ---------------------------------------------------------------------
// Internal: page parsing
// ---------------------------------------------------------------------

type ParsedPage = {
  candidates: Candidate[];
  cursor: number | string | null;
  has_more: boolean;
};

function parsePage(body: unknown): ParsedPage | null {
  if (!body || typeof body !== "object") return null;
  const root = body as Record<string, unknown>;
  // EnsembleData's keyword search wraps results under `data`. The
  // search variant returns aweme entries either as data.aweme_list or
  // (older shape) as a list of {aweme_info: {...}} wrappers. Try both.
  const data = (root.data ?? root) as Record<string, unknown>;
  let entries: unknown[] = [];
  const list = data.aweme_list;
  if (Array.isArray(list)) {
    entries = list;
  } else if (Array.isArray(data)) {
    entries = data as unknown[];
  } else {
    return null;
  }

  const cursorRaw = data.cursor;
  const cursor =
    typeof cursorRaw === "number" || typeof cursorRaw === "string"
      ? cursorRaw
      : null;
  const hasMoreRaw = data.has_more;
  const has_more = hasMoreRaw === 1 || hasMoreRaw === true;

  const candidates: Candidate[] = [];
  for (const raw of entries) {
    const c = parseCandidate(raw);
    if (c) candidates.push(c);
  }
  return { candidates, cursor, has_more };
}

function parseCandidate(raw: unknown): Candidate | null {
  if (!raw || typeof raw !== "object") return null;
  // Some search responses wrap the post under .aweme_info; others
  // expose fields at the entry root. Support both.
  const r = raw as Record<string, unknown>;
  const inner =
    (r.aweme_info && typeof r.aweme_info === "object"
      ? (r.aweme_info as Record<string, unknown>)
      : r);

  const post_id = stringOrNull(inner.aweme_id ?? inner.id);
  if (!post_id) return null;

  const author = (inner.author ?? {}) as Record<string, unknown>;
  const handle = stringOrNull(author.unique_id ?? author.uniqueId);
  if (!handle) return null;
  const cleanHandle = handle.replace(/^@+/, "").trim().toLowerCase();
  if (!cleanHandle) return null;

  const post_url = `https://www.tiktok.com/@${cleanHandle}/video/${post_id}`;

  const stats = (inner.statistics ?? {}) as Record<string, unknown>;
  const video = (inner.video ?? {}) as Record<string, unknown>;
  const imagePost = inner.image_post_info;
  const is_video = !imagePost && Object.keys(video).length > 0;

  const caption =
    typeof inner.desc === "string" && inner.desc ? inner.desc : null;

  const hashtags: string[] = [];
  const textExtra = inner.text_extra;
  if (Array.isArray(textExtra)) {
    for (const t of textExtra) {
      if (t && typeof t === "object") {
        const name = (t as Record<string, unknown>).hashtag_name;
        if (typeof name === "string" && name) hashtags.push(name);
      }
    }
  }

  const createTime = inner.create_time;
  const posted_at =
    typeof createTime === "number" && createTime > 0
      ? new Date(createTime * 1000).toISOString()
      : null;

  const thumb =
    firstUrl(get(video, ["origin_cover", "url_list"])) ??
      firstUrl(get(video, ["cover", "url_list"]));

  const duration_seconds = msToSeconds(video.duration);
  const aspect_ratio = simplifyAspectRatio(
    intOrNull(video.width),
    intOrNull(video.height),
  );

  return {
    post_id,
    post_url,
    handle: cleanHandle,
    caption,
    view_count: intOrNull(stats.play_count),
    like_count: intOrNull(stats.digg_count),
    comment_count: intOrNull(stats.comment_count),
    share_count: intOrNull(stats.share_count),
    thumbnail_url: thumb,
    posted_at,
    duration_seconds,
    aspect_ratio,
    hashtags,
    is_video,
  };
}

// Small typed helpers (kept local to avoid importing client.ts internals).

function intOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function stringOrNull(v: unknown): string | null {
  if (typeof v === "string" && v.trim() !== "") return v.trim();
  if (typeof v === "number") return String(v);
  return null;
}

function firstUrl(v: unknown): string | null {
  if (Array.isArray(v) && v.length > 0 && typeof v[0] === "string") {
    return v[0];
  }
  return null;
}

function msToSeconds(v: unknown): number | null {
  const n = intOrNull(v);
  if (n === null) return null;
  // TikTok video.duration historically reported in milliseconds; some
  // older responses report seconds. Heuristic: > 1000 → ms.
  return n > 1000 ? Math.round(n / 1000) : n;
}

function simplifyAspectRatio(
  width: number | null,
  height: number | null,
): string | null {
  if (!width || !height || width <= 0 || height <= 0) return null;
  const w = Math.round(width);
  const h = Math.round(height);
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const g = gcd(w, h);
  return `${w / g}:${h / g}`;
}

function get(obj: unknown, path: string[]): unknown {
  let cur: unknown = obj;
  for (const k of path) {
    if (cur && typeof cur === "object" && k in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[k];
    } else {
      return undefined;
    }
  }
  return cur;
}
