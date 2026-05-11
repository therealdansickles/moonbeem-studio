// YouTube Data API v3 client + URL parser — Edge Function (Deno) copy.
//
// ⚠ DUAL-COPY: mirrors src/lib/youtube/index.ts. Edge Functions can't
// import from src/, so the YT logic lives in BOTH places. When this
// file changes, update the src/ copy in the same commit.
//
// Reads YOUTUBE_API_KEY via Deno.env.get. Quota: videos.list with
// part=statistics,snippet,contentDetails costs 1 unit per CALL (up
// to 50 IDs per call). Free tier 10,000 units/day.

const YT_API_BASE = "https://www.googleapis.com/youtube/v3";
const FETCH_TIMEOUT_MS = 5000;
const MAX_IDS_PER_CALL = 50;

export type YouTubeErrorCategory =
  | "missing_key"
  | "not_found"
  | "rate_limited"
  | "transient"
  | "parse_error";

export type YouTubeVideoStats = {
  view_count: number | null;
  like_count: number | null;
  comment_count: number | null;
  thumbnail_url: string | null;
  duration_seconds: number | null;
  posted_at: string | null;
  channel_title: string | null;
};

export type FetchVideoStatsResult = {
  byId: Map<string, YouTubeVideoStats>;
  error: YouTubeErrorCategory | null;
  raw_payload: unknown | null;
};

export async function fetchVideoStats(
  videoIds: string[],
  apiKey: string | undefined,
): Promise<FetchVideoStatsResult> {
  const out: FetchVideoStatsResult = {
    byId: new Map(),
    error: null,
    raw_payload: null,
  };
  if (!apiKey) {
    out.error = "missing_key";
    return out;
  }
  if (videoIds.length === 0) return out;
  if (videoIds.length > MAX_IDS_PER_CALL) {
    out.error = "parse_error";
    return out;
  }

  const url = new URL(`${YT_API_BASE}/videos`);
  url.searchParams.set("part", "statistics,snippet,contentDetails");
  url.searchParams.set("id", videoIds.join(","));
  url.searchParams.set("key", apiKey);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url.toString(), { signal: ctrl.signal });
  } catch {
    clearTimeout(timer);
    out.error = "transient";
    return out;
  }
  clearTimeout(timer);

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  out.raw_payload = body;

  if (res.status === 403) {
    out.error = "rate_limited";
    return out;
  }
  if (res.status === 404) {
    out.error = "not_found";
    return out;
  }
  if (res.status >= 500 || !res.ok) {
    out.error = "transient";
    return out;
  }

  if (!body || typeof body !== "object") {
    out.error = "parse_error";
    return out;
  }
  const items = (body as Record<string, unknown>).items;
  if (!Array.isArray(items)) {
    out.error = "parse_error";
    return out;
  }
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const id = stringValue(obj.id);
    if (!id) continue;
    out.byId.set(id, mapVideoItem(obj));
  }
  return out;
}

function mapVideoItem(item: Record<string, unknown>): YouTubeVideoStats {
  const stats = (item.statistics ?? {}) as Record<string, unknown>;
  const snippet = (item.snippet ?? {}) as Record<string, unknown>;
  const content = (item.contentDetails ?? {}) as Record<string, unknown>;
  const thumbs = (snippet.thumbnails ?? {}) as Record<string, unknown>;
  return {
    view_count: toIntOrNull(stats.viewCount),
    like_count: toIntOrNull(stats.likeCount),
    comment_count: toIntOrNull(stats.commentCount),
    thumbnail_url: pickBestThumbnail(thumbs),
    duration_seconds: parseIso8601Duration(content.duration),
    posted_at: stringValue(snippet.publishedAt),
    channel_title: stringValue(snippet.channelTitle),
  };
}

function pickBestThumbnail(thumbs: Record<string, unknown>): string | null {
  for (const key of ["maxres", "standard", "high", "medium", "default"]) {
    const t = thumbs[key];
    if (t && typeof t === "object") {
      const url = stringValue((t as Record<string, unknown>).url);
      if (url) return url;
    }
  }
  return null;
}

function parseIso8601Duration(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const m = v.match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return null;
  const [, dStr, hStr, mStr, sStr] = m;
  const d = dStr ? parseInt(dStr, 10) : 0;
  const h = hStr ? parseInt(hStr, 10) : 0;
  const min = mStr ? parseInt(mStr, 10) : 0;
  const s = sStr ? parseInt(sStr, 10) : 0;
  const total = d * 86400 + h * 3600 + min * 60 + s;
  return Number.isFinite(total) && total > 0 ? total : null;
}

export function extractYouTubeVideoId(url: string): string | null {
  if (!url || typeof url !== "string") return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  if (host === "youtu.be" || host.endsWith(".youtu.be")) {
    const m = parsed.pathname.match(/^\/([A-Za-z0-9_-]{11})(?:\/|$|\?)/);
    return m ? m[1] : null;
  }
  if (!host.endsWith("youtube.com")) return null;
  const v = parsed.searchParams.get("v");
  if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return v;
  const m = parsed.pathname.match(
    /^\/(?:shorts|embed|v|live)\/([A-Za-z0-9_-]{11})(?:\/|$|\?)/,
  );
  return m ? m[1] : null;
}

function toIntOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function stringValue(v: unknown): string | null {
  if (typeof v === "string" && v !== "") return v;
  return null;
}
