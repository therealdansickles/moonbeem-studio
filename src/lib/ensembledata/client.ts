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

import { extractYouTubeVideoId, fetchVideoStats } from "@/lib/youtube";

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
  thumbnail_url: string | null;
  duration_seconds: number | null;
  aspect_ratio: string | null;
  // Platform-side handle extracted from the response — currently only
  // populated for Instagram (data.owner.username). upsert.ts writes
  // this to fan_edits.creator_handle_displayed when that column is
  // null.
  creator_handle_displayed: string | null;
  // SEC-2: usernames of VERIFIED coauthors (Instagram coauthor_producers
  // with is_verified===true). Absent/empty on non-IG and on posts with no
  // verified coauthors. The submit ownership gate treats owner.username OR
  // any of these as an eligible post author.
  verified_coauthor_handles?: string[];
  // ISO 8601 timestamp from the source. YouTube populates from
  // snippet.publishedAt. Other platforms leave null (EnsembleData
  // doesn't surface posted_at reliably on its per-post lookups).
  // upsert.ts backfills fan_edits.posted_at when this is non-null AND
  // the current column value is null (first-write-wins, matching the
  // thumbnail backfill rule).
  posted_at: string | null;
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
  switch (platform.toLowerCase()) {
    case "tiktok": {
      const m = path.match(/\/(?:video|v|photo)\/(\d+)/);
      return m ? m[1] : null;
    }
    case "instagram": {
      const m = path.match(/\/(?:reel|reels|p|tv)\/([A-Za-z0-9_-]+)/);
      return m ? m[1] : null;
    }
    case "youtube":
      // Delegate to the shared YT module so all callers (modal embed,
      // Discover add-by-URL, view-tracking refresh) parse the same set
      // of URL forms identically.
      return extractYouTubeVideoId(url);
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
    thumbnail_url: null,
    duration_seconds: null,
    aspect_ratio: null,
    creator_handle_displayed: null,
    posted_at: null as string | null,
    raw_payload: null as unknown | null,
    fetched_at,
  };

  const platformLower = (args.platform ?? "").toLowerCase();
  const id = parseShortcodeFromUrl(args.embed_url, platformLower);
  if (!id) {
    return { ...empty, error: "parse_error" };
  }

  // YouTube goes through the official YT Data API v3, NOT EnsembleData
  // (which doesn't actually expose a /youtube/video/info endpoint —
  // probed 2026-05-10 in openapi.json). Branch early so the
  // EnsembleData token check doesn't gate a YT-only refresh.
  if (platformLower === "youtube") {
    return await fetchYouTubeMetrics(id, fetched_at);
  }

  const token = process.env.ENSEMBLEDATA_TOKEN;
  if (!token) {
    // Missing token is operational, not a per-row failure. Returning
    // 'transient' lets the orchestrator skip without flipping
    // lifecycle state. The caller should also fail fast at startup
    // when token is missing, before reaching here.
    return { ...empty, error: "transient" };
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
    thumbnail_url: metrics.thumbnail_url,
    duration_seconds: metrics.duration_seconds,
    aspect_ratio: metrics.aspect_ratio,
    creator_handle_displayed: metrics.creator_handle_displayed,
    verified_coauthor_handles: metrics.verified_coauthor_handles,
    // posted_at: null on EnsembleData-backed platforms — their
    // per-post endpoints don't surface a reliable timestamp.
    // YouTube branches through fetchYouTubeMetrics which fills this.
    posted_at: null,
    raw_payload: body,
    error: null,
    fetched_at,
  };
}

// ---------------------------------------------------------------------
// YouTube — official YT Data API v3 (separate vendor from EnsembleData)
// ---------------------------------------------------------------------
//
// Lives in this file so callers (view-tracking orchestrator) get one
// fetchEngagementMetrics() surface regardless of platform. The actual
// YT API client + URL parser are in src/lib/youtube/ — this is just
// the adapter that maps YouTubeVideoStats → FetchEngagementResult.
//
// Quota model differs from EnsembleData (1 unit/call covers up to 50
// IDs vs. 1 unit/post on EnsembleData). v1 calls one ID per refresh
// to fit the existing orchestrator loop; batching to 50 is a future
// orchestrator-only refactor.

async function fetchYouTubeMetrics(
  videoId: string,
  fetched_at: Date,
): Promise<FetchEngagementResult> {
  const empty = {
    view_count: null,
    like_count: null,
    comment_count: null,
    share_count: null,
    thumbnail_url: null,
    duration_seconds: null,
    aspect_ratio: null,
    creator_handle_displayed: null,
    posted_at: null as string | null,
    raw_payload: null as unknown | null,
    fetched_at,
  };

  const apiKey = process.env.YOUTUBE_API_KEY;
  const result = await fetchVideoStats([videoId], apiKey);
  if (result.error === "missing_key") {
    // Same shape as EnsembleData's missing-token path — operational,
    // not per-row. Orchestrator skips without flipping lifecycle state.
    return { ...empty, raw_payload: result.raw_payload, error: "transient" };
  }
  if (result.error === "rate_limited") {
    return { ...empty, raw_payload: result.raw_payload, error: "rate_limited" };
  }
  if (result.error === "not_found") {
    return { ...empty, raw_payload: result.raw_payload, error: "not_found" };
  }
  if (result.error === "transient") {
    return { ...empty, raw_payload: result.raw_payload, error: "transient" };
  }
  if (result.error === "parse_error") {
    return { ...empty, raw_payload: result.raw_payload, error: "parse_error" };
  }
  const stats = result.byId.get(videoId);
  if (!stats) {
    // Video ID was in our request but didn't come back — YT omits
    // missing videos from items[] (deleted, private, age-restricted).
    return { ...empty, raw_payload: result.raw_payload, error: "not_found" };
  }
  return {
    view_count: stats.view_count,
    like_count: stats.like_count,
    comment_count: stats.comment_count,
    share_count: null, // YT doesn't expose share counts on the API.
    thumbnail_url: stats.thumbnail_url,
    duration_seconds: stats.duration_seconds,
    aspect_ratio: null, // YT needs part=player + maxHeight to compute.
    creator_handle_displayed: null, // channel_title kept in payload
                                    // only — not URL-safe; not stored
                                    // on refresh.
    posted_at: stats.posted_at,
    raw_payload: result.raw_payload,
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
  thumbnail_url: string | null;
  duration_seconds: number | null;
  aspect_ratio: string | null;
  creator_handle_displayed: string | null;
  // SEC-2: VERIFIED coauthor usernames (IG only); see FetchEngagementResult.
  verified_coauthor_handles?: string[];
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

function msToSeconds(ms: unknown): number | null {
  const n = toIntOrNull(ms);
  return n === null ? null : Math.round(n / 1000);
}

// Reduce w:h to lowest terms ("1080:1920" → "9:16"). Returns null
// when either dimension is missing/zero/negative.
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

function firstStringInList(v: unknown): string | null {
  if (Array.isArray(v) && v.length > 0 && typeof v[0] === "string") {
    return v[0];
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

function emptyMetrics(): Metrics {
  return {
    view_count: null,
    like_count: null,
    comment_count: null,
    share_count: null,
    thumbnail_url: null,
    duration_seconds: null,
    aspect_ratio: null,
    creator_handle_displayed: null,
  };
}

function mapMetrics(platform: Platform, body: unknown): Metrics {
  if (!body || typeof body !== "object") return emptyMetrics();
  // EnsembleData typically wraps its response as { data: { ... } }.
  // Some endpoints also return { data: {...}, units_charged: N }.
  // Fall through to the root if .data isn't present.
  const data = (body as Record<string, unknown>).data ?? body;

  switch (platform) {
    case "tiktok": {
      // TikTok response wraps the result in an array under `data`:
      //   { data: [{ statistics: {...}, video: {...} }], ... }
      const first = Array.isArray(data) ? data[0] : null;
      const stats = first ? get(first, ["statistics"]) : null;
      const video = first ? get(first, ["video"]) : null;
      // origin_cover preserves the video aspect (tplv-tiktokx-shrink);
      // cover is square-cropped (tplv-tiktokx-cropcenter). Prefer
      // origin_cover, fall back to cover.
      const thumb =
        firstStringInList(get(video, ["origin_cover", "url_list"])) ??
          firstStringInList(get(video, ["cover", "url_list"]));
      // duration is in milliseconds.
      const duration_seconds = msToSeconds(get(video, ["duration"]));
      const aspect_ratio = simplifyAspectRatio(
        toIntOrNull(get(video, ["width"])),
        toIntOrNull(get(video, ["height"])),
      );
      return {
        view_count: toIntOrNull(get(stats, ["play_count"])),
        like_count: toIntOrNull(get(stats, ["digg_count"])),
        comment_count: toIntOrNull(get(stats, ["comment_count"])),
        share_count: toIntOrNull(get(stats, ["share_count"])),
        thumbnail_url: thumb,
        duration_seconds,
        aspect_ratio,
        creator_handle_displayed: null,
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
      // display_url preserves original aspect; thumbnail_src is a
      // square crop. Prefer display_url for the player thumbnail.
      const display = get(data, ["display_url"]);
      const thumbSrc = get(data, ["thumbnail_src"]);
      const thumb = typeof display === "string"
        ? display
        : (typeof thumbSrc === "string" ? thumbSrc : null);
      // video_duration is decimal seconds (e.g. 134.837).
      const dur = get(data, ["video_duration"]);
      const duration_seconds = typeof dur === "number"
        ? Math.round(dur)
        : toIntOrNull(dur);
      const aspect_ratio = simplifyAspectRatio(
        toIntOrNull(get(data, ["dimensions", "width"])),
        toIntOrNull(get(data, ["dimensions", "height"])),
      );
      // data.owner.username — Instagram's authoritative handle for
      // the post. Used by upsert.ts to backfill creator_handle_displayed
      // on rows where it's null.
      const ownerUsername = get(data, ["owner", "username"]);
      const creator_handle = typeof ownerUsername === "string" && ownerUsername
        ? ownerUsername
        : null;
      // SEC-2: surface VERIFIED coauthors (data.coauthor_producers[] with
      // is_verified===true) so the submit gate can accept a verified
      // coauthor, not just the owner. Owner stays the displayed default.
      const coauthorProducers = get(data, ["coauthor_producers"]);
      const verified_coauthor_handles = Array.isArray(coauthorProducers)
        ? coauthorProducers
            .filter(
              (c): c is Record<string, unknown> =>
                !!c &&
                typeof c === "object" &&
                (c as Record<string, unknown>).is_verified === true,
            )
            .map((c) => c.username)
            .filter((u): u is string => typeof u === "string" && u.length > 0)
        : [];
      return {
        view_count: toIntOrNull(get(data, ["video_play_count"])),
        like_count: rawLike !== null && rawLike >= 0 ? rawLike : null,
        comment_count: toIntOrNull(
          get(data, ["edge_media_to_comment", "count"]),
        ),
        share_count: null, // IG doesn't expose share count
        thumbnail_url: thumb,
        duration_seconds,
        aspect_ratio,
        creator_handle_displayed: creator_handle,
        verified_coauthor_handles,
      };
    }
    case "youtube":
      // Unreachable — fetchEngagementMetrics short-circuits to the YT
      // Data API v3 branch (fetchYouTubeMetrics) before reaching here.
      // Kept for switch-exhaustiveness; returns empty if somehow hit.
      return emptyMetrics();
    case "twitter": {
      // Twitter response: data.views.count is a string ("8944"),
      // engagement fields under data.legacy.*. Media (thumbnail,
      // video info, dimensions) lives in extended_entities.media[0]
      // when the tweet has media; tweets without media → all visual
      // fields null.
      const extMedia = get(data, ["legacy", "extended_entities", "media"]);
      const entMedia = get(data, ["legacy", "entities", "media"]);
      const mediaCandidate =
        (Array.isArray(extMedia) && extMedia[0]) ??
          (Array.isArray(entMedia) && entMedia[0]) ?? null;
      const media = mediaCandidate && typeof mediaCandidate === "object"
        ? mediaCandidate as Record<string, unknown>
        : null;

      const mediaUrl = media ? media["media_url_https"] : null;
      const thumb = typeof mediaUrl === "string" ? mediaUrl : null;

      const duration_seconds = media
        ? msToSeconds(get(media, ["video_info", "duration_millis"]))
        : null;

      let w: number | null = null;
      let h: number | null = null;
      if (media) {
        const ar = get(media, ["video_info", "aspect_ratio"]);
        if (Array.isArray(ar) && ar.length === 2) {
          w = toIntOrNull(ar[0]);
          h = toIntOrNull(ar[1]);
        } else {
          w = toIntOrNull(get(media, ["original_info", "width"]));
          h = toIntOrNull(get(media, ["original_info", "height"]));
        }
      }
      const aspect_ratio = simplifyAspectRatio(w, h);

      return {
        view_count: toIntOrNull(get(data, ["views", "count"])),
        like_count: toIntOrNull(get(data, ["legacy", "favorite_count"])),
        comment_count: toIntOrNull(get(data, ["legacy", "reply_count"])),
        share_count: toIntOrNull(get(data, ["legacy", "retweet_count"])),
        thumbnail_url: thumb,
        duration_seconds,
        aspect_ratio,
        creator_handle_displayed: null,
      };
    }
    default:
      return emptyMetrics();
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
// parseShortcodeFromUrl('https://www.tiktok.com/@starcashdoc/photo/7615333991847120142', 'tiktok')
//   -> '7615333991847120142'
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
