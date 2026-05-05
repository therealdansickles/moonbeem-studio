// EnsembleData client wrapper for the view-tracking pipeline.
//
// ⚠ DUAL-COPY: this file is replicated at
//   supabase/functions/view-tracking/ensemble.ts
// because Edge Functions can't import from src/. Field mappings and
// URL parsing live in BOTH files. When you adjust mappings here
// (likely after first production invocation reveals shape mismatches),
// also update the Edge Function copy. Cross-reference noted at the
// top of the Edge Function file too.

//
// One public function — fetchEngagementMetrics — adapts a fan_edit's
// platform + embed_url into a single typed response with view/like/
// comment/share counts plus an explicit error category. The
// orchestrator (supabase/functions/view-tracking/index.ts) maps the
// error category to fan_edits.view_tracking_status transitions and
// view_tracking_failure_count increments per spec.
//
// Endpoint shapes (verified against real EnsembleData responses
// 2026-05-05):
//   TikTok:    GET /tt/post/info?url={post_url}&token={token}
//              data[0].statistics.{play_count, digg_count,
//                                  comment_count, share_count}
//              Response wraps the result in an array; take element [0].
//   Instagram: GET /instagram/post/details?code={shortcode}&token={token}
//              data.video_play_count
//              data.edge_media_preview_like.count
//                (returns -1 when like_and_view_counts_disabled — we
//                 map -1 to null, since the post intentionally hides
//                 the count, it isn't a real "0 likes")
//              data.edge_media_to_comment.count
//              No share_count exposed.
//   YouTube:   GET /youtube/video/info?id={video_id}&token={token}
//              data.statistics.{viewCount, likeCount, commentCount}
//              String values per YT native shape; coerce to int.
//              No share_count exposed.
//   Twitter:   GET /twitter/post/info?id={tweet_id}&token={token}
//              data.views.count           (string — coerce to int)
//              data.legacy.favorite_count (like_count)
//              data.legacy.reply_count    (comment_count)
//              data.legacy.retweet_count  (share_count)
//
// Error categories returned to the caller:
//   not_found     — HTTP 404 (post deleted)
//   private       — HTTP 403, OR a 200 whose body shape can't be
//                   field-mapped (we treat unparseable-but-valid
//                   responses conservatively as 'parse_error', not
//                   'private', to avoid false-flipping lifecycle state)
//   rate_limited  — HTTP 429
//   transient     — HTTP 5xx, network error, fetch abort/timeout,
//                   missing token
//   parse_error   — URL doesn't yield a valid id/shortcode for the
//                   platform, OR response body's field mapping yields
//                   all-nulls (likely shape drift)
//
// raw_payload is always populated when there's a response body to
// capture (forensic trail for shape-drift debugging). On network
// failure / abort it's null.

const ENSEMBLEDATA_BASE = "https://ensembledata.com/apis";
const FETCH_TIMEOUT_MS = 5000;

export type Platform = "tiktok" | "instagram" | "youtube" | "twitter";

export type FetchErrorCategory =
  | "not_found"
  | "private"
  | "rate_limited"
  | "transient"
  | "parse_error";

export type FetchEngagementResult = {
  view_count: number | null;
  like_count: number | null;
  comment_count: number | null;
  share_count: number | null;
  raw_payload: unknown | null;
  error: FetchErrorCategory | null;
  fetched_at: Date;
};

// ---------------------------------------------------------------------
// URL → platform-canonical id
// ---------------------------------------------------------------------
//
// Returns the value the per-platform EnsembleData endpoint expects:
//   tiktok    — numeric video id (the API actually takes the full URL
//               via &url=, but we parse the id here for validation;
//               fetchEngagementMetrics passes the original URL)
//   instagram — alphanumeric shortcode from /reel|reels|p|tv/<code>/
//   youtube   — 11-char video id, handles youtu.be, watch?v=,
//               /shorts/, /embed/
//   twitter   — numeric tweet id from /status/<id>
//
// Returns null if the URL is malformed or doesn't match the
// expected pattern for the platform.

export function parseShortcodeFromUrl(
  url: string,
  platform: string,
): string | null {
  if (!url || typeof url !== "string") return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const path = parsed.pathname;
  const host = parsed.hostname.toLowerCase();
  switch (platform.toLowerCase()) {
    case "tiktok": {
      const m = path.match(/\/(?:video|v)\/(\d+)/);
      return m ? m[1] : null;
    }
    case "instagram": {
      const m = path.match(/\/(?:reel|reels|p|tv)\/([A-Za-z0-9_-]+)/);
      return m ? m[1] : null;
    }
    case "youtube": {
      if (host === "youtu.be" || host.endsWith(".youtu.be")) {
        const m = path.match(/^\/([A-Za-z0-9_-]{11})(?:\/|$|\?)/);
        return m ? m[1] : null;
      }
      const v = parsed.searchParams.get("v");
      if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return v;
      const m = path.match(
        /^\/(?:shorts|embed|v|live)\/([A-Za-z0-9_-]{11})(?:\/|$|\?)/,
      );
      return m ? m[1] : null;
    }
    case "twitter": {
      const m = path.match(/\/status\/(\d+)/);
      return m ? m[1] : null;
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------
// Public: fetchEngagementMetrics
// ---------------------------------------------------------------------

export async function fetchEngagementMetrics(args: {
  platform: string;
  embed_url: string;
}): Promise<FetchEngagementResult> {
  const fetched_at = new Date();
  const empty = {
    view_count: null,
    like_count: null,
    comment_count: null,
    share_count: null,
    raw_payload: null as unknown | null,
    fetched_at,
  };

  const token = process.env.ENSEMBLEDATA_TOKEN;
  if (!token) {
    // Missing token is operational, not a per-row failure. Returning
    // 'transient' lets the orchestrator skip without flipping
    // lifecycle state. The caller should also fail fast at startup
    // when token is missing, before reaching here.
    return { ...empty, error: "transient" };
  }

  const platformLower = (args.platform ?? "").toLowerCase();
  const id = parseShortcodeFromUrl(args.embed_url, platformLower);
  if (!id) {
    return { ...empty, error: "parse_error" };
  }

  let apiUrl: string;
  switch (platformLower) {
    case "tiktok":
      apiUrl = `${ENSEMBLEDATA_BASE}/tt/post/info?url=${
        encodeURIComponent(args.embed_url)
      }&token=${encodeURIComponent(token)}`;
      break;
    case "instagram":
      apiUrl = `${ENSEMBLEDATA_BASE}/instagram/post/details?code=${
        encodeURIComponent(id)
      }&token=${encodeURIComponent(token)}`;
      break;
    case "youtube":
      apiUrl = `${ENSEMBLEDATA_BASE}/youtube/video/info?id=${
        encodeURIComponent(id)
      }&token=${encodeURIComponent(token)}`;
      break;
    case "twitter":
      apiUrl = `${ENSEMBLEDATA_BASE}/twitter/post/info?id=${
        encodeURIComponent(id)
      }&token=${encodeURIComponent(token)}`;
      break;
    default:
      return { ...empty, error: "parse_error" };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(apiUrl, { signal: ctrl.signal });
  } catch {
    clearTimeout(timer);
    // Network error or AbortError. Both treated as transient — the
    // orchestrator retries on the next cron tick without state change.
    return { ...empty, error: "transient" };
  }
  clearTimeout(timer);

  // Always attempt to capture body for raw_payload, even on error
  // status. If it's not JSON, raw_payload stays null.
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  if (res.status === 404) {
    return { ...empty, raw_payload: body, error: "not_found" };
  }
  if (res.status === 403) {
    return { ...empty, raw_payload: body, error: "private" };
  }
  if (res.status === 429) {
    return { ...empty, raw_payload: body, error: "rate_limited" };
  }
  if (res.status >= 500) {
    return { ...empty, raw_payload: body, error: "transient" };
  }
  if (!res.ok) {
    // Other 4xx (400, 401, 422, etc). Could be a malformed token or
    // unexpected param. Treat as transient so we don't permanently
    // mark posts dead due to a server-side configuration issue.
    return { ...empty, raw_payload: body, error: "transient" };
  }

  const metrics = mapMetrics(platformLower as Platform, body);
  const allNull =
    metrics.view_count === null &&
    metrics.like_count === null &&
    metrics.comment_count === null &&
    metrics.share_count === null;

  // 200 OK with no extractable metrics suggests EnsembleData's
  // response shape drifted, OR the post is private and the upstream
  // returned an empty data object instead of 403. Conservative:
  // 'parse_error', not 'private'. The orchestrator skips parse_error
  // without flipping lifecycle state; if the situation persists,
  // we'll see it in the failed counter and the raw_payload trail
  // and adjust the field mapping.
  if (allNull && body !== null) {
    return { ...empty, raw_payload: body, error: "parse_error" };
  }

  return {
    view_count: metrics.view_count,
    like_count: metrics.like_count,
    comment_count: metrics.comment_count,
    share_count: metrics.share_count,
    raw_payload: body,
    error: null,
    fetched_at,
  };
}

// ---------------------------------------------------------------------
// Internal: shape-mapping helpers
// ---------------------------------------------------------------------

type Metrics = {
  view_count: number | null;
  like_count: number | null;
  comment_count: number | null;
  share_count: number | null;
};

function toIntOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
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

function mapMetrics(platform: Platform, body: unknown): Metrics {
  if (!body || typeof body !== "object") {
    return {
      view_count: null,
      like_count: null,
      comment_count: null,
      share_count: null,
    };
  }
  // EnsembleData typically wraps its response as { data: { ... } }.
  // Some endpoints also return { data: {...}, units_charged: N }.
  // Fall through to the root if .data isn't present.
  const data = (body as Record<string, unknown>).data ?? body;

  switch (platform) {
    case "tiktok": {
      // TikTok response wraps the result in an array under `data`:
      //   { data: [{ statistics: {...} }], ... }
      // Take the first element. Empty/missing array → all nulls.
      const first = Array.isArray(data) ? data[0] : null;
      const stats = first ? get(first, ["statistics"]) : null;
      return {
        view_count: toIntOrNull(get(stats, ["play_count"])),
        like_count: toIntOrNull(get(stats, ["digg_count"])),
        comment_count: toIntOrNull(get(stats, ["comment_count"])),
        share_count: toIntOrNull(get(stats, ["share_count"])),
      };
    }
    case "instagram": {
      // edge_media_preview_like.count returns -1 when the post sets
      // like_and_view_counts_disabled. That isn't a real "0 likes",
      // it's an intentional hide — map -1 → null so we don't write
      // a misleading zero into fan_edits.like_count.
      const rawLike = toIntOrNull(
        get(data, ["edge_media_preview_like", "count"]),
      );
      return {
        view_count: toIntOrNull(get(data, ["video_play_count"])),
        like_count: rawLike !== null && rawLike >= 0 ? rawLike : null,
        comment_count: toIntOrNull(
          get(data, ["edge_media_to_comment", "count"]),
        ),
        share_count: null, // IG doesn't expose share count
      };
    }
    case "youtube": {
      // YT statistics fields are strings per YT API convention.
      const stats = get(data, ["statistics"]) ?? data;
      return {
        view_count: toIntOrNull(get(stats, ["viewCount"])),
        like_count: toIntOrNull(get(stats, ["likeCount"])),
        comment_count: toIntOrNull(get(stats, ["commentCount"])),
        share_count: null, // YT doesn't expose share count
      };
    }
    case "twitter": {
      // Twitter response: data.views.count is a string ("8944"),
      // engagement fields under data.legacy.*.
      return {
        view_count: toIntOrNull(get(data, ["views", "count"])),
        like_count: toIntOrNull(get(data, ["legacy", "favorite_count"])),
        comment_count: toIntOrNull(get(data, ["legacy", "reply_count"])),
        share_count: toIntOrNull(get(data, ["legacy", "retweet_count"])),
      };
    }
    default:
      return {
        view_count: null,
        like_count: null,
        comment_count: null,
        share_count: null,
      };
  }
}

// ---------------------------------------------------------------------
// Inline reference cases (no test runner — manual smoke verify the
// per-platform parsing on first production invocation).
//
// Real Erupcja fan_edits in the DB:
//
// parseShortcodeFromUrl('https://www.instagram.com/reel/DXHbbZnCKTL/', 'instagram')
//   -> 'DXHbbZnCKTL'
//
// parseShortcodeFromUrl('https://www.tiktok.com/@number.1.angel10/video/7627616681170324758', 'tiktok')
//   -> '7627616681170324758'
//
// parseShortcodeFromUrl('https://x.com/xcxsource/status/2037213168209191391', 'twitter')
//   -> '2037213168209191391'
//
// parseShortcodeFromUrl('https://twitter.com/xcxsource/status/2037213168209191391', 'twitter')
//   -> '2037213168209191391'
//
// YouTube URL forms (no real samples in DB yet):
//
// parseShortcodeFromUrl('https://youtu.be/dQw4w9WgXcQ', 'youtube')
//   -> 'dQw4w9WgXcQ'
//
// parseShortcodeFromUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'youtube')
//   -> 'dQw4w9WgXcQ'
//
// parseShortcodeFromUrl('https://www.youtube.com/shorts/dQw4w9WgXcQ', 'youtube')
//   -> 'dQw4w9WgXcQ'
//
// Negative cases:
//
// parseShortcodeFromUrl('not a url', 'tiktok')                -> null
// parseShortcodeFromUrl('https://example.com', 'instagram')   -> null
// parseShortcodeFromUrl('https://twitter.com/xcxsource', 'twitter') -> null
//
// Expected fetchEngagementMetrics responses (verify on first prod call):
//
// // Successful Instagram reel
// {
//   view_count: 12345,
//   like_count: 678,         // null if like_and_view_counts_disabled (raw -1)
//   comment_count: 42,
//   share_count: null,       // IG doesn't expose
//   raw_payload: { data: { video_play_count: 12345,
//                          edge_media_preview_like: { count: 678 },
//                          edge_media_to_comment: { count: 42 }, ... },
//                  units_charged: N },
//   error: null,
//   fetched_at: <Date>,
// }
//
// // Successful TikTok video
// {
//   view_count: 100000,        // data[0].statistics.play_count
//   like_count: 5000,          // data[0].statistics.digg_count
//   comment_count: 100,
//   share_count: 25,
//   raw_payload: { data: [{ statistics: { play_count: 100000, ... } }], ... },
//   error: null,
//   fetched_at: <Date>,
// }
//
// // Successful Tweet
// {
//   view_count: 8944,          // parseInt(data.views.count, 10)
//   like_count: 432,           // data.legacy.favorite_count
//   comment_count: 12,         // data.legacy.reply_count
//   share_count: 5,            // data.legacy.retweet_count
//   raw_payload: { data: { views: { count: "8944" }, legacy: {...} }, ... },
//   error: null,
//   fetched_at: <Date>,
// }
//
// // Deleted TikTok video
// {
//   view_count: null, like_count: null, comment_count: null, share_count: null,
//   raw_payload: { error: 'not_found', ... } | null,
//   error: 'not_found',
//   fetched_at: <Date>,
// }
//
// // Rate-limited
// {
//   view_count: null, ..., raw_payload: { detail: 'rate limit exceeded' },
//   error: 'rate_limited', fetched_at: <Date>,
// }
//
// // URL parse failure
// {
//   view_count: null, ..., raw_payload: null, error: 'parse_error',
// }
