// YouTube Data API v3 client + URL parser.
//
// Why a separate module from src/lib/ensembledata/: different vendor,
// different auth model (API key vs token query param — though both
// are query-string in practice), different response shape, different
// quota model. Keep concerns separated; the orchestrator dispatches
// per-platform.
//
// ⚠ DUAL-COPY: Edge Function side lives at
//   supabase/functions/view-tracking/youtube.ts
// (Deno-compatible mirror, can't import from src/). When the
// orchestrator behavior changes here, update the Edge Function copy
// in the same commit.
//
// Quota: videos.list with part=statistics,snippet,contentDetails
// costs 1 quota unit per CALL (not per video). Up to 50 video IDs
// per call. Free-tier ceiling 10,000 units/day → 500,000 video
// refreshes/day. Plenty for current scale; we batch when the
// orchestrator passes >1 ID.

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
  // ISO 8601 timestamp from snippet.publishedAt — backfilled into
  // fan_edits.posted_at when that column is NULL (first-write-wins).
  posted_at: string | null;
  // YouTube channel display name (e.g. "Rotten Tomatoes Trailers").
  // NOT URL-safe — paired with the canonical /channel/<id> or
  // /@handle URL in author_url at ingest time. Not stored on refresh.
  channel_title: string | null;
};

export type FetchVideoStatsResult = {
  // Keyed by videoId — missing IDs (deleted/private videos) just
  // don't appear in the map. Caller treats absence as not_found.
  byId: Map<string, YouTubeVideoStats>;
  error: YouTubeErrorCategory | null;
  raw_payload: unknown | null;
};

// videos.list with id=A,B,C&part=statistics,snippet,contentDetails.
// Accepts 1..50 IDs per call; caller batches if more are needed.
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
    // Caller bug — batching is the caller's responsibility for now.
    // Treat as parse_error so it surfaces visibly in logs without
    // 4xx'ing the upstream service.
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
    // Quota exhausted or key invalid — both surface as 403 from
    // YouTube. Treat as rate_limited so the orchestrator backs off
    // without flipping lifecycle state.
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

  // Parse items[]; missing IDs simply don't appear (deleted/private).
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
    const stats = mapVideoItem(obj);
    out.byId.set(id, stats);
  }
  return out;
}

function mapVideoItem(item: Record<string, unknown>): YouTubeVideoStats {
  const stats = (item.statistics ?? {}) as Record<string, unknown>;
  const snippet = (item.snippet ?? {}) as Record<string, unknown>;
  const content = (item.contentDetails ?? {}) as Record<string, unknown>;

  const thumbs = (snippet.thumbnails ?? {}) as Record<string, unknown>;
  const thumb = pickBestThumbnail(thumbs);

  return {
    view_count: toIntOrNull(stats.viewCount),
    like_count: toIntOrNull(stats.likeCount),
    comment_count: toIntOrNull(stats.commentCount),
    thumbnail_url: thumb,
    duration_seconds: parseIso8601Duration(content.duration),
    posted_at: stringValue(snippet.publishedAt),
    channel_title: stringValue(snippet.channelTitle),
  };
}

// Pick the largest available thumbnail: maxres → standard → high →
// medium → default. Standard sometimes missing for very short videos.
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

// YouTube returns ISO 8601 PT duration (e.g. "PT4M13S", "PT1H30M",
// "PT45S", "P0D" for livestreams). Returns total seconds or null on
// shape mismatch.
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

// ===================================================================
// URL parser — shared with FanEditModal + ensembledata/client
// ===================================================================
//
// Reference test cases (verified manually):
//   /watch?v=ID  : "https://www.youtube.com/watch?v=dQw4w9WgXcQ" → "dQw4w9WgXcQ"
//   /shorts/ID   : "https://www.youtube.com/shorts/abc123XYZ_-" → "abc123XYZ_-"
//   youtu.be/ID  : "https://youtu.be/dQw4w9WgXcQ" → "dQw4w9WgXcQ"
//   /embed/ID    : "https://www.youtube.com/embed/dQw4w9WgXcQ" → "dQw4w9WgXcQ"
//   /v/ID        : "https://www.youtube.com/v/dQw4w9WgXcQ" → "dQw4w9WgXcQ"
//   /live/ID     : "https://www.youtube.com/live/dQw4w9WgXcQ" → "dQw4w9WgXcQ"
//   trailing query: "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42" → "dQw4w9WgXcQ"
//   not a URL    : "notaurl" → null
//   wrong host   : "https://vimeo.com/123" → null
//   wrong path   : "https://www.youtube.com/feed/trending" → null

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
  // youtube.com or www.youtube.com or m.youtube.com etc.
  if (!host.endsWith("youtube.com")) return null;
  const v = parsed.searchParams.get("v");
  if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return v;
  const m = parsed.pathname.match(
    /^\/(?:shorts|embed|v|live)\/([A-Za-z0-9_-]{11})(?:\/|$|\?)/,
  );
  return m ? m[1] : null;
}

// ===================================================================
// Internal helpers
// ===================================================================

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
