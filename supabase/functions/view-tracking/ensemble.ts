// EnsembleData client adapter for the view-tracking Edge Function.
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

  const token = Deno.env.get("ENSEMBLEDATA_TOKEN");
  if (!token) {
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
    raw_payload: body,
    error: null,
    fetched_at,
  };
}

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

function mapMetrics(platform: Platform, body: unknown): Metrics {
  if (!body || typeof body !== "object") {
    return {
      view_count: null,
      like_count: null,
      comment_count: null,
      share_count: null,
    };
  }
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
        share_count: null,
      };
    }
    case "youtube": {
      const stats = get(data, ["statistics"]) ?? data;
      return {
        view_count: toIntOrNull(get(stats, ["viewCount"])),
        like_count: toIntOrNull(get(stats, ["likeCount"])),
        comment_count: toIntOrNull(get(stats, ["commentCount"])),
        share_count: null,
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
