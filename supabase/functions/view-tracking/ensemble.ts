// EnsembleData + YouTube Data API client adapter for view-tracking.
//
// ⚠ DUAL-COPY: this file mirrors src/lib/ensembledata/client.ts.
// Edge Functions can't import from src/, so the field mappings and
// URL parsing live in BOTH files. When you adjust mappings here
// (likely after first production invocation reveals shape
// mismatches), also update the src/lib copy.
//
// Differences from src/lib/ensembledata/client.ts:
//   - Reads ENSEMBLEDATA_TOKEN via Deno.env.get instead of process.env
//   - No external imports needed
//   - Same public API: fetchEngagementMetrics + parseShortcodeFromUrl
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

import { extractYouTubeVideoId, fetchVideoStats } from "./youtube.ts";

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
  // null (resolves the @anon Instagram fan_edits whose ingest path
  // didn't capture a handle). Other platforms return null until we
  // verify their response shapes.
  creator_handle_displayed: string | null;
  // ISO 8601 timestamp from the source. YouTube populates from
  // snippet.publishedAt via fetchYouTubeMetrics. Other platforms
  // null. upsert.ts backfills fan_edits.posted_at when this is
  // non-null AND the current column value is null (first-write-wins).
  posted_at: string | null;
  raw_payload: unknown | null;
  error: FetchErrorCategory | null;
  fetched_at: Date;
};

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
      // /photo/ added 2026-05-11 to close dual-copy drift with
      // src/lib/ensembledata/client.ts (commit 6783928). Without it,
      // photo carousels (aweme_type 150) parse_error and silently
      // stall the picker queue.
      const m = path.match(/\/(?:video|v|photo)\/(\d+)/);
      return m ? m[1] : null;
    }
    case "instagram": {
      const m = path.match(/\/(?:reel|reels|p|tv)\/([A-Za-z0-9_-]+)/);
      return m ? m[1] : null;
    }
    case "youtube":
      return extractYouTubeVideoId(url);
    case "twitter": {
      const m = path.match(/\/status\/(\d+)/);
      return m ? m[1] : null;
    }
    default:
      return null;
  }
}

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
  // (which has no per-video lookup endpoint). Branch early so the
  // EnsembleData token check doesn't gate a YT-only refresh.
  if (platformLower === "youtube") {
    return await fetchYouTubeMetrics(id, fetched_at);
  }

  const token = Deno.env.get("ENSEMBLEDATA_TOKEN");
  if (!token) {
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
    return { ...empty, error: "transient" };
  }
  clearTimeout(timer);

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
    return { ...empty, raw_payload: body, error: "transient" };
  }

  const metrics = mapMetrics(platformLower as Platform, body);
  const allNull =
    metrics.view_count === null &&
    metrics.like_count === null &&
    metrics.comment_count === null &&
    metrics.share_count === null;

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
    // posted_at: null on EnsembleData-backed platforms — YouTube
    // branches through fetchYouTubeMetrics which fills this.
    posted_at: null,
    raw_payload: body,
    error: null,
    fetched_at,
  };
}

// YouTube — official YT Data API v3 (separate vendor from EnsembleData).
// Mirrors src/lib/ensembledata/client.ts fetchYouTubeMetrics. Maps
// YouTubeVideoStats → FetchEngagementResult so the orchestrator sees a
// uniform shape regardless of which API answered.
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

  const apiKey = Deno.env.get("YOUTUBE_API_KEY");
  const result = await fetchVideoStats([videoId], apiKey);
  if (result.error === "missing_key") {
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
    return { ...empty, raw_payload: result.raw_payload, error: "not_found" };
  }
  return {
    view_count: stats.view_count,
    like_count: stats.like_count,
    comment_count: stats.comment_count,
    share_count: null,
    thumbnail_url: stats.thumbnail_url,
    duration_seconds: stats.duration_seconds,
    aspect_ratio: null,
    creator_handle_displayed: null,
    posted_at: stats.posted_at,
    raw_payload: result.raw_payload,
    error: null,
    fetched_at,
  };
}

type Metrics = {
  view_count: number | null;
  like_count: number | null;
  comment_count: number | null;
  share_count: number | null;
  thumbnail_url: string | null;
  duration_seconds: number | null;
  aspect_ratio: string | null;
  creator_handle_displayed: string | null;
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
    if (
      cur && typeof cur === "object" &&
      k in (cur as Record<string, unknown>)
    ) {
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
      // on rows where it's null (e.g. fan_edits whose ingest path
      // didn't capture a handle).
      const ownerUsername = get(data, ["owner", "username"]);
      const creator_handle = typeof ownerUsername === "string" && ownerUsername
        ? ownerUsername
        : null;
      return {
        view_count: toIntOrNull(get(data, ["video_play_count"])),
        like_count: rawLike !== null && rawLike >= 0 ? rawLike : null,
        comment_count: toIntOrNull(
          get(data, ["edge_media_to_comment", "count"]),
        ),
        share_count: null,
        thumbnail_url: thumb,
        duration_seconds,
        aspect_ratio,
        creator_handle_displayed: creator_handle,
      };
    }
    case "youtube":
      // Unreachable — fetchEngagementMetrics short-circuits to
      // fetchYouTubeMetrics before reaching mapMetrics for YT.
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
