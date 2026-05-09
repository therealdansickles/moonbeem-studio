// EnsembleData TikTok keyword-search wrapper for the Discover tab.
//
// Endpoint: GET https://ensembledata.com/apis/tt/keyword/search
// Auth:     ?token=...   (query param, not header)
// Required: name, period
// Optional: cursor (integer), sorting ('0'|'1'|'2'), country, match_exactly
//
// Response shape (verified against EnsembleData docs sample +
// canonical fixture, 2026-05-09):
//
//   {
//     data: {
//       nextCursor?: number,        // absent → end of results
//       data: [
//         {
//           type: 1,                // 1 = video; non-1 = images/etc.
//           aweme_info: {
//             aweme_id, desc, create_time (unix seconds),
//             statistics: { play_count, digg_count, comment_count,
//                           share_count, collect_count },
//             author: { unique_id, nickname, uid, sec_uid,
//                       follower_count, avatar_medium: { url_list } },
//             video:  { cover: { url_list }, origin_cover: { url_list },
//                       duration?, width?, height? },
//             text_extra: [{ type, hashtag_name }],
//             share_url, ...
//           }
//         },
//         ...
//       ]
//     }
//   }
//
// Pagination terminates when `nextCursor` is undefined on a response
// (NOT when `has_more` is false — that field doesn't exist here).
//
// Cost: 1 unit per page on Wood plan. We cap at ~5 pages for our
// max_results=100 ceiling.

const ENSEMBLEDATA_BASE = "https://ensembledata.com/apis";
const FETCH_TIMEOUT_MS = 15000;

export type SearchPeriod = "1d" | "7d" | "30d" | "90d" | "180d" | "all";

// EnsembleData period encoding: integer-as-string in days. 0 = all-time.
const PERIOD_TO_DAYS: Record<SearchPeriod, string> = {
  "1d": "1",
  "7d": "7",
  "30d": "30",
  "90d": "90",
  "180d": "180",
  all: "0",
};

export type Candidate = {
  post_id: string;
  post_url: string; // canonical desktop URL constructed from handle + id
  caption: string;
  posted_at: number; // Unix seconds (TikTok create_time)
  view_count: number;
  like_count: number;
  comment_count: number;
  share_count: number;
  save_count: number;
  author_handle: string;
  author_display_name: string | null;
  author_avatar_url: string | null;
  thumbnail_url: string | null;
  hashtags: string[];
  // Video-only marker. type:1 entries map to true; non-video (image
  // slideshow, etc.) entries are dropped at parse time so they never
  // surface as candidates. Field is kept on the type for callers that
  // want to assert.
  is_video: true;
};

export type SearchResult = {
  candidates: Candidate[];
  units_estimated: number;
  pages_fetched: number;
  raw_payload?: unknown; // last response body, for parse_error debugging
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
  const periodDays = PERIOD_TO_DAYS[args.period] ?? "180";
  const wanted = Math.max(1, Math.min(args.max_results, 100));

  const candidates: Candidate[] = [];
  const seenIds = new Set<string>();
  let cursor: number | null = null;
  let pages = 0;
  let lastError: SearchResult["error"];
  let lastBody: unknown = null;

  // Hard cap on pages for safety. Wanted=100 → 5 pages of 20.
  const MAX_PAGES = 6;

  while (candidates.length < wanted && pages < MAX_PAGES) {
    const url = new URL(`${ENSEMBLEDATA_BASE}/tt/keyword/search`);
    url.searchParams.set("name", args.query);
    url.searchParams.set("period", periodDays);
    url.searchParams.set("token", token);
    if (cursor !== null) url.searchParams.set("cursor", String(cursor));

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
    lastBody = body;

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
    if (page.nextCursor === undefined) break;
    cursor = page.nextCursor;
  }

  // Surface parse_error when we got responses but no candidates,
  // since that's the exact case Dan needs to debug field-path drift.
  if (!lastError && pages > 0 && candidates.length === 0) {
    lastError = "parse_error";
  }

  return {
    candidates: candidates.slice(0, wanted),
    units_estimated: pages,
    pages_fetched: pages,
    raw_payload: lastBody,
    error: lastError,
  };
}

// ---------------------------------------------------------------------
// Parser — canonical EnsembleData TikTok keyword-search shape.
// Exported for fixture-based testing.
// ---------------------------------------------------------------------

export type ParsedPage = {
  candidates: Candidate[];
  nextCursor?: number;
};

export function parsePage(body: unknown): ParsedPage | null {
  if (!body || typeof body !== "object") return null;
  const root = body as Record<string, unknown>;
  const inner = root.data;
  if (!inner || typeof inner !== "object") return null;
  const innerObj = inner as Record<string, unknown>;
  const items = innerObj.data;
  if (!Array.isArray(items)) return null;

  const candidates: Candidate[] = [];
  for (const raw of items) {
    const c = parseCandidate(raw);
    if (c) candidates.push(c);
  }

  const nc = innerObj.nextCursor;
  const nextCursor = typeof nc === "number" ? nc : undefined;

  return { candidates, nextCursor };
}

function parseCandidate(item: unknown): Candidate | null {
  if (!item || typeof item !== "object") return null;
  const wrapper = item as Record<string, unknown>;

  // Drop image slideshows / non-video items. TikTok keyword search
  // returns mixed-type entries; only type:1 is a regular video post.
  if (wrapper.type !== 1) return null;

  const a = wrapper.aweme_info;
  if (!a || typeof a !== "object") return null;
  const aw = a as Record<string, unknown>;

  const author = (aw.author ?? {}) as Record<string, unknown>;
  const stats = (aw.statistics ?? {}) as Record<string, unknown>;
  const video = (aw.video ?? {}) as Record<string, unknown>;
  const cover = (video.cover ?? {}) as Record<string, unknown>;
  const avatarMedium = (author.avatar_medium ?? {}) as Record<string, unknown>;

  const aweme_id = stringValue(aw.aweme_id);
  const unique_id = stringValue(author.unique_id);
  if (!aweme_id || !unique_id) return null;

  const create_time = numberValue(aw.create_time) ?? 0;
  const desc = stringValue(aw.desc) ?? stringValue(aw.content_desc) ?? "";

  const textExtra = aw.text_extra;
  const hashtags: string[] = [];
  if (Array.isArray(textExtra)) {
    for (const t of textExtra) {
      if (t && typeof t === "object") {
        const te = t as Record<string, unknown>;
        if (te.type === 1 && typeof te.hashtag_name === "string" && te.hashtag_name) {
          hashtags.push(te.hashtag_name);
        }
      }
    }
  }

  return {
    post_id: aweme_id,
    post_url: `https://www.tiktok.com/@${unique_id}/video/${aweme_id}`,
    caption: desc,
    posted_at: create_time,
    view_count: numberValue(stats.play_count) ?? 0,
    like_count: numberValue(stats.digg_count) ?? 0,
    comment_count: numberValue(stats.comment_count) ?? 0,
    share_count: numberValue(stats.share_count) ?? 0,
    save_count: numberValue(stats.collect_count) ?? 0,
    author_handle: unique_id,
    author_display_name: stringValue(author.nickname) ?? null,
    author_avatar_url: firstUrl(avatarMedium.url_list),
    thumbnail_url: firstUrl(cover.url_list),
    hashtags,
    is_video: true,
  };
}

function stringValue(v: unknown): string | null {
  if (typeof v === "string" && v !== "") return v;
  if (typeof v === "number") return String(v);
  return null;
}

function numberValue(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function firstUrl(v: unknown): string | null {
  if (Array.isArray(v) && v.length > 0 && typeof v[0] === "string") {
    return v[0];
  }
  return null;
}
