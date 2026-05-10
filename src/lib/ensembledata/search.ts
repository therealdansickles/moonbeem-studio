// EnsembleData multi-platform Discover wrappers.
//
// TikTok keyword search   — searchTikTokKeyword,   /tt/keyword/search
// YouTube hashtag search  — searchYouTubeHashtag,  /youtube/hashtag/search
//
// All searchers return the same Candidate shape so the UI + add-route
// can stay platform-generic. Per-platform parsers handle the wildly
// different response shapes (TikTok wraps in array under data.data,
// YouTube nests two renderer flavors — videoRenderer vs reelItemRenderer
// — under data.videos[]).
//
// Auth: ?token=<ENSEMBLEDATA_TOKEN>  (query param, not header)
//
// Coverage map (probed via openapi.json 2026-05-10): EnsembleData has
// no IG hashtag-post-feed and no Twitter keyword search. Those
// platforms can only be added via the add-by-URL fallback today, which
// uses /instagram/post/details and /twitter/post/info per-post lookups.
// See followup memory "Discover tab — Instagram + Twitter platform
// support" for the vendor evaluation track.
//
// ─── TikTok response shape (verified 2026-05-09) ───
// {
//   data: {
//     nextCursor?: number,        // absent → end of results
//     data: [
//       { type: 1, aweme_info: { aweme_id, desc, create_time,
//                                statistics: { play_count, digg_count,
//                                              comment_count, share_count,
//                                              collect_count },
//                                author: { unique_id, nickname,
//                                          avatar_medium: { url_list } },
//                                video:  { cover: { url_list },
//                                          origin_cover: { url_list } },
//                                text_extra: [{ type, hashtag_name }] } },
//       …
//     ]
//   }
// }
// Pagination terminates when nextCursor is undefined.
// Cost: 1 unit per page on Wood plan. Max 5 pages for max_results=100.
//
// ─── YouTube hashtag-search response shape (verified via openapi.json) ───
// {
//   data: {
//     info: { pageTitle: "#tag", … },
//     videos: [
//       { videoRenderer: { videoId, title.runs[0].text, viewCountText.simpleText,
//                          longBylineText.runs[0].{text, navigationEndpoint
//                            .browseEndpoint.canonicalBaseUrl}, lengthText,
//                          publishedTimeText.simpleText, thumbnail.thumbnails[] } },
//       { richItemRenderer: { content: { reelItemRenderer:
//             { videoId, headline.simpleText, viewCountText.simpleText,
//               viewCountText.accessibility.accessibilityData.label,
//               thumbnail.thumbnails[],
//               navigationEndpoint.commandMetadata.webCommandMetadata.url } } } },
//       …
//     ]
//   }
// }
// Single HTTP call; depth param controls volume (depth 1 ≈ 35 videos,
// depth N ≈ 35*N). Cost: ceil(returned/20) units. Caveats:
// - viewCountText is a UI string ("5.4M views" / "133,744 views" /
//   "1.2K views" / "5.4 million views") — must parse to integer.
// - posted_at is relative ("1 day ago") — we set 0 (unknown).
// - like / comment / share counts NOT in search response. Toggling
//   get_additional_info=true would add them at +1 unit/video, refused
//   for v1 (cost). Surface as null and let formatStat render "—".

const ENSEMBLEDATA_BASE = "https://ensembledata.com/apis";
const FETCH_TIMEOUT_MS = 15000;

export type SearchPeriod = "1d" | "7d" | "30d" | "90d" | "180d" | "all";

// EnsembleData TikTok period encoding: integer-as-string in days. 0 = all-time.
const PERIOD_TO_DAYS: Record<SearchPeriod, string> = {
  "1d": "1",
  "7d": "7",
  "30d": "30",
  "90d": "90",
  "180d": "180",
  all: "0",
};

export type CandidatePlatform = "tiktok" | "youtube" | "threads";

export type Candidate = {
  // Which EnsembleData endpoint produced this candidate. The downstream
  // add route uses this to set fan_edits.platform without re-inferring
  // from the URL host (which can ambiguous on URL-shorteners or new
  // domains).
  platform: CandidatePlatform;
  post_id: string;
  post_url: string; // canonical desktop URL constructed from handle + id
  caption: string;
  posted_at: number; // Unix seconds; 0 = unknown (YouTube only knows "1d ago")
  // Pre-formatted relative-time string when the source has only that
  // (e.g. YouTube hashtag-search returns publishedTimeText "1 day ago"
  // with no underlying timestamp). UI prefers posted_relative over
  // computing from posted_at when both are present and posted_at=0.
  // Always null for TikTok (posted_at is precise).
  posted_relative: string | null;
  view_count: number;
  // Nullable across platforms — YouTube hashtag search doesn't return
  // engagement counts in its base response. TikTok always populates;
  // YouTube parser sets these to 0 (per Dan's 2026-05-10 spec) so
  // formatStat renders "0" rather than "—" for visual consistency.
  like_count: number | null;
  comment_count: number | null;
  share_count: number | null;
  save_count: number | null;
  // For TikTok this is the canonical @-handle (URL-safe, no spaces).
  // For YouTube regular videos this is the channel display NAME from
  // longBylineText.runs[0].text per Dan's 2026-05-10 spec — may
  // contain spaces and is NOT URL-safe; pair with author_url for
  // navigation. YouTube shorts: null (search response doesn't carry
  // channel info on reelItemRenderer).
  author_handle: string | null;
  author_display_name: string | null;
  // Pre-constructed channel URL when the source provides one. UI
  // prefers this over computing https://platform/@handle from
  // author_handle, since the display name and the URL-safe handle
  // differ on YouTube (e.g. "Rotten Tomatoes Trailers" vs
  // /@RottenTomatoesTrailers). Null when not available; UI falls
  // back to platform-aware URL construction.
  author_url: string | null;
  author_avatar_url: string | null;
  thumbnail_url: string | null;
  hashtags: string[];
  // Video-only marker. Both platforms guarantee video at parse time
  // (TikTok: type:1 filter; YouTube hashtag-search returns only videos
  // and shorts). Kept on the type for callers that want to assert.
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
    platform: "tiktok",
    post_id: aweme_id,
    post_url: `https://www.tiktok.com/@${unique_id}/video/${aweme_id}`,
    caption: desc,
    posted_at: create_time,
    posted_relative: null,
    view_count: numberValue(stats.play_count) ?? 0,
    like_count: numberValue(stats.digg_count) ?? 0,
    comment_count: numberValue(stats.comment_count) ?? 0,
    share_count: numberValue(stats.share_count) ?? 0,
    save_count: numberValue(stats.collect_count) ?? 0,
    author_handle: unique_id,
    author_display_name: stringValue(author.nickname) ?? null,
    author_url: null, // UI builds tiktok.com/@<handle> from author_handle
    author_avatar_url: firstUrl(avatarMedium.url_list),
    thumbnail_url: firstUrl(cover.url_list),
    hashtags,
    is_video: true,
  };
}

// =====================================================================
// YouTube hashtag search — /youtube/hashtag/search
// =====================================================================

export async function searchYouTubeHashtag(args: {
  query: string;       // hashtag with or without leading '#'
  max_results: number; // 1..100, clamped
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
  const wanted = Math.max(1, Math.min(args.max_results, 100));
  // Strip a single leading '#' if present. Multiple #'s or whitespace
  // collapse to the same trimmed root.
  const hashtag = args.query.trim().replace(/^#+/, "");
  if (!hashtag) {
    return {
      candidates: [],
      units_estimated: 0,
      pages_fetched: 0,
      error: "parse_error",
    };
  }
  // depth ≈ 35 videos per unit. Cover wanted in one call; cap at 3 to
  // bound spend (depth 3 ≈ 105 videos ≈ ~6 units).
  const depth = Math.min(3, Math.max(1, Math.ceil(wanted / 35)));

  const url = new URL(`${ENSEMBLEDATA_BASE}/youtube/hashtag/search`);
  url.searchParams.set("name", hashtag);
  url.searchParams.set("depth", String(depth));
  url.searchParams.set("token", token);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url.toString(), { signal: ctrl.signal });
  } catch {
    clearTimeout(timer);
    return {
      candidates: [],
      units_estimated: 0,
      pages_fetched: 0,
      error: "transient",
    };
  }
  clearTimeout(timer);

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  if (res.status === 429) {
    return {
      candidates: [],
      units_estimated: 0,
      pages_fetched: 1,
      raw_payload: body,
      error: "rate_limited",
    };
  }
  if (res.status === 404) {
    return {
      candidates: [],
      units_estimated: 0,
      pages_fetched: 1,
      raw_payload: body,
      error: "not_found",
    };
  }
  if (res.status >= 500 || !res.ok) {
    return {
      candidates: [],
      units_estimated: 0,
      pages_fetched: 1,
      raw_payload: body,
      error: "transient",
    };
  }

  const candidates = parseYouTubeHashtagPage(body);
  if (candidates === null) {
    return {
      candidates: [],
      units_estimated: 1, // we still got billed for the call
      pages_fetched: 1,
      raw_payload: body,
      error: "parse_error",
    };
  }

  // Dedupe by videoId and cap at wanted.
  const seen = new Set<string>();
  const unique: Candidate[] = [];
  for (const c of candidates) {
    if (seen.has(c.post_id)) continue;
    seen.add(c.post_id);
    unique.push(c);
    if (unique.length >= wanted) break;
  }

  // EnsembleData prices YouTube hashtag at ceil(returned/20). Use the
  // RAW returned count (not the dedupe-and-clamp count) since they
  // billed for the full payload.
  const units_estimated = Math.max(1, Math.ceil(candidates.length / 20));

  // 200 OK with no extractable candidates suggests shape drift — flag
  // as parse_error so the route surfaces the truncated raw payload.
  let error: SearchResult["error"];
  if (unique.length === 0) error = "parse_error";

  return {
    candidates: unique,
    units_estimated,
    pages_fetched: 1,
    raw_payload: body,
    error,
  };
}

// Exported for fixture-based testing. Returns null on shape mismatch
// (so the searcher can flag parse_error). Empty array means valid
// shape but no items.
export function parseYouTubeHashtagPage(body: unknown): Candidate[] | null {
  if (!body || typeof body !== "object") return null;
  const root = body as Record<string, unknown>;
  const data = root.data;
  if (!data || typeof data !== "object") return null;
  const videos = (data as Record<string, unknown>).videos;
  if (!Array.isArray(videos)) return null;

  const out: Candidate[] = [];
  for (const item of videos) {
    const c = parseYouTubeItem(item);
    if (c) out.push(c);
  }
  return out;
}

function parseYouTubeItem(item: unknown): Candidate | null {
  if (!item || typeof item !== "object") return null;
  const obj = item as Record<string, unknown>;

  // Real production shape (verified against /admin captured payload
  // 2026-05-10): every video is wrapped under
  // richItemRenderer.content.{videoRenderer | reelItemRenderer}.
  // The OpenAPI doc sample (top-level videoRenderer / reelItemRenderer)
  // appears to be a different/older shape — kept as defensive
  // fallback in case YT toggles back.
  const richItem = obj.richItemRenderer;
  if (richItem && typeof richItem === "object") {
    const content = (richItem as Record<string, unknown>).content;
    if (content && typeof content === "object") {
      const c = content as Record<string, unknown>;
      const vr = c.videoRenderer;
      if (vr && typeof vr === "object") {
        return parseYouTubeVideoRenderer(vr as Record<string, unknown>);
      }
      const rr = c.reelItemRenderer;
      if (rr && typeof rr === "object") {
        return parseYouTubeReelRenderer(rr as Record<string, unknown>);
      }
    }
  }
  // Top-level fallbacks — rare in current prod responses but defensive.
  const topVR = obj.videoRenderer;
  if (topVR && typeof topVR === "object") {
    return parseYouTubeVideoRenderer(topVR as Record<string, unknown>);
  }
  const topRR = obj.reelItemRenderer;
  if (topRR && typeof topRR === "object") {
    return parseYouTubeReelRenderer(topRR as Record<string, unknown>);
  }
  return null;
}

function parseYouTubeVideoRenderer(
  r: Record<string, unknown>,
): Candidate | null {
  const videoId = stringValue(r.videoId);
  if (!videoId) return null;

  const titleRunsText = firstRunText(r.title);
  const caption = titleRunsText ?? "";

  // Per Dan's 2026-05-10 spec: author_handle holds the display NAME
  // ("Rotten Tomatoes Trailers"), not the URL-safe @-handle. URL
  // construction uses canonicalBaseUrl (e.g. /@RottenTomatoesTrailers)
  // when present.
  const longByline = r.longBylineText;
  const channelName = firstRunText(longByline);
  const channelUrlPath = canonicalBaseUrlFromRuns(longByline);
  const author_url = channelUrlPath
    ? `https://www.youtube.com${channelUrlPath}`
    : null;

  // viewCountText.simpleText is "133,744 views"; accessibility.label
  // sometimes carries fuller "133,744 views" too. Either parses fine.
  const viewCount = parseViewCountText(r.viewCountText);

  // Pick the largest thumbnail by width.
  const thumb = pickLargestThumbnail(r.thumbnail);

  // publishedTimeText.simpleText is YouTube's only timestamp signal in
  // search responses ("1 day ago", "3 weeks ago"). UI uses this in
  // place of computing from posted_at when posted_at is 0.
  const ptt = r.publishedTimeText;
  const posted_relative = (ptt && typeof ptt === "object")
    ? stringValue((ptt as Record<string, unknown>).simpleText)
    : null;

  return {
    platform: "youtube",
    post_id: videoId,
    post_url: `https://www.youtube.com/watch?v=${videoId}`,
    caption,
    posted_at: 0, // YouTube search returns relative time only
    posted_relative,
    view_count: viewCount ?? 0,
    // Engagement counts are not in the hashtag-search response. Set
    // 0 (per Dan's spec) so the UI renders "0" rather than "—" — a
    // real refresh path via YT Data API v3 will overwrite later.
    like_count: 0,
    comment_count: 0,
    share_count: 0,
    save_count: 0,
    author_handle: channelName,
    author_display_name: channelName,
    author_url,
    author_avatar_url: null,
    thumbnail_url: thumb,
    hashtags: [],
    is_video: true,
  };
}

function parseYouTubeReelRenderer(
  r: Record<string, unknown>,
): Candidate | null {
  const videoId = stringValue(r.videoId);
  if (!videoId) return null;

  const headline = r.headline;
  const caption = (headline && typeof headline === "object"
    ? stringValue((headline as Record<string, unknown>).simpleText)
    : null) ?? "";

  const viewCount = parseViewCountText(r.viewCountText);
  const thumb = pickLargestThumbnail(r.thumbnail);

  return {
    platform: "youtube",
    post_id: videoId,
    // Shorts have a /shorts/<id> canonical URL but /watch?v= also
    // resolves and is consistent with regular videos. Pick /shorts/
    // so the link routes to the vertical player.
    post_url: `https://www.youtube.com/shorts/${videoId}`,
    caption,
    posted_at: 0,
    // Shorts in hashtag-search responses don't carry publishedTimeText
    // (the field exists on videoRenderer, not reelItemRenderer). Leave
    // null so UI shows blank.
    posted_relative: null,
    view_count: viewCount ?? 0,
    like_count: 0,
    comment_count: 0,
    share_count: 0,
    save_count: 0,
    // Shorts in YouTube hashtag pages don't carry channel info in the
    // search response. Per Dan's spec: author_handle = null. Downstream
    // insertFanEditCandidate accepts null and inserts with
    // creator_id=null.
    author_handle: null,
    author_display_name: null,
    author_url: null,
    author_avatar_url: null,
    thumbnail_url: thumb,
    hashtags: [],
    is_video: true,
  };
}

// "5.4M views" / "133,744 views" / "1.2K views" / "5.4 million views"
// → integer. Returns null on shape mismatch / unrecognized form.
// Exported for fixture testing.
export function parseViewCountText(v: unknown): number | null {
  if (!v || typeof v !== "object") return null;
  const obj = v as Record<string, unknown>;
  // Prefer accessibility.accessibilityData.label (more verbose, e.g.
  // "5.4 million views" — disambiguates K/M/B from comma grouping).
  const ax = obj.accessibility;
  let label: string | null = null;
  if (ax && typeof ax === "object") {
    const data = (ax as Record<string, unknown>).accessibilityData;
    if (data && typeof data === "object") {
      label = stringValue((data as Record<string, unknown>).label);
    }
  }
  const simple = stringValue(obj.simpleText);
  const text = label ?? simple;
  if (!text) return null;

  // "No views" / "Recommended for you" → null
  if (/no views/i.test(text)) return 0;

  // "5.4 million views" / "1.2 thousand views" / "3 billion views"
  const wordMatch = text.match(/([\d,.]+)\s*(thousand|million|billion)/i);
  if (wordMatch) {
    const base = parseFloat(wordMatch[1].replace(/,/g, ""));
    if (!Number.isFinite(base)) return null;
    const mult = wordMatch[2].toLowerCase() === "thousand"
      ? 1_000
      : wordMatch[2].toLowerCase() === "million"
      ? 1_000_000
      : 1_000_000_000;
    return Math.round(base * mult);
  }

  // "5.4M" / "1.2K" / "3.1B"
  const suffixMatch = text.match(/([\d,.]+)\s*([KMB])/i);
  if (suffixMatch) {
    const base = parseFloat(suffixMatch[1].replace(/,/g, ""));
    if (!Number.isFinite(base)) return null;
    const s = suffixMatch[2].toUpperCase();
    const mult = s === "K" ? 1_000 : s === "M" ? 1_000_000 : 1_000_000_000;
    return Math.round(base * mult);
  }

  // "133,744 views" / "1234 views"
  const plain = text.match(/([\d,]+)/);
  if (plain) {
    const n = parseInt(plain[1].replace(/,/g, ""), 10);
    return Number.isFinite(n) ? n : null;
  }

  return null;
}

// title.runs / longBylineText.runs / etc. all wrap text as
// { runs: [{ text: "..." }, …] } | { simpleText: "..." }.
function firstRunText(v: unknown): string | null {
  if (!v || typeof v !== "object") return null;
  const obj = v as Record<string, unknown>;
  const simple = stringValue(obj.simpleText);
  if (simple) return simple;
  const runs = obj.runs;
  if (Array.isArray(runs) && runs.length > 0) {
    const first = runs[0];
    if (first && typeof first === "object") {
      return stringValue((first as Record<string, unknown>).text);
    }
  }
  return null;
}

// Returns the raw canonicalBaseUrl path (e.g. "/@RottenTomatoesTrailers"
// or "/channel/UC...") from
// runs[0].navigationEndpoint.browseEndpoint.canonicalBaseUrl. Caller
// concatenates with "https://www.youtube.com" for the final URL.
function canonicalBaseUrlFromRuns(v: unknown): string | null {
  if (!v || typeof v !== "object") return null;
  const runs = (v as Record<string, unknown>).runs;
  if (!Array.isArray(runs) || runs.length === 0) return null;
  const first = runs[0];
  if (!first || typeof first !== "object") return null;
  const navEnd = (first as Record<string, unknown>).navigationEndpoint;
  if (!navEnd || typeof navEnd !== "object") return null;
  const browse = (navEnd as Record<string, unknown>).browseEndpoint;
  if (!browse || typeof browse !== "object") return null;
  return stringValue((browse as Record<string, unknown>).canonicalBaseUrl);
}

// Reference fixture for parseYouTubeItem (regular video flavor).
// Verified against Dan's captured /admin payload 2026-05-10 for
// hashtag "erupcja", videos[0]:
//
// Input shape:
//   {
//     richItemRenderer: {
//       content: {
//         videoRenderer: {
//           videoId: "OiHk3tFSK84",
//           title: { runs: [{ text: "Erupcja Trailer #1 (2026)" }] },
//           longBylineText: {
//             runs: [{
//               text: "Rotten Tomatoes Trailers",
//               navigationEndpoint: {
//                 browseEndpoint: {
//                   browseId: "UCi8e0iOVk1fEOogdfu4YgfA",
//                   canonicalBaseUrl: "/@RottenTomatoesTrailers"
//                 }
//               }
//             }]
//           },
//           publishedTimeText: { simpleText: "2 months ago" },
//           viewCountText: { simpleText: "41,980 views" },
//           thumbnail: { thumbnails: [
//             { url: "...sqp=mq...", width: 320, height: 180 },
//             { url: "...hqdefault.jpg?...", width: 480, height: 270 }
//           ] },
//           lengthText: { simpleText: "2:06" }
//         }
//       }
//     }
//   }
//
// Expected Candidate output:
//   {
//     platform: "youtube",
//     post_id: "OiHk3tFSK84",
//     post_url: "https://www.youtube.com/watch?v=OiHk3tFSK84",
//     caption: "Erupcja Trailer #1 (2026)",
//     posted_at: 0,
//     posted_relative: "2 months ago",
//     view_count: 41980,
//     like_count: 0, comment_count: 0, share_count: 0, save_count: 0,
//     author_handle: "Rotten Tomatoes Trailers",
//     author_display_name: "Rotten Tomatoes Trailers",
//     author_url: "https://www.youtube.com/@RottenTomatoesTrailers",
//     author_avatar_url: null,
//     thumbnail_url: "...hqdefault.jpg?..." (largest by width),
//     hashtags: [],
//     is_video: true
//   }

function pickLargestThumbnail(v: unknown): string | null {
  if (!v || typeof v !== "object") return null;
  const list = (v as Record<string, unknown>).thumbnails;
  if (!Array.isArray(list) || list.length === 0) return null;
  let best: { url: string; width: number } | null = null;
  for (const t of list) {
    if (!t || typeof t !== "object") continue;
    const obj = t as Record<string, unknown>;
    const url = stringValue(obj.url);
    if (!url) continue;
    const width = numberValue(obj.width) ?? 0;
    if (!best || width > best.width) best = { url, width };
  }
  return best?.url ?? null;
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

// =====================================================================
// Threads keyword search — /threads/keyword/search
// =====================================================================
//
// Smell-test gate: candidate insertion is intentionally NOT supported
// for Threads in the add route or in find_or_create_stub_creator. This
// searcher exists so we can surface candidates in the Discover UI and
// evaluate whether Threads has any film fan_edit signal worth the
// schema/RPC widening work. If signal is good, follow-up commit adds
// 'threads' to fan_edits.platform CHECK + creator_socials.platform
// CHECK + ALLOWED_SOCIAL_PLATFORMS + parseShortcodeFromUrl +
// inferPlatformFromHost. If signal is weak, we simply remove the
// platform option from the UI and this code stays unused.
//
// Endpoint shape (from openapi.json example, verified 2026-05-10):
//   data: [
//     {
//       node: {
//         thread: {
//           thread_items: [{ post: {
//             pk: "3455813358522634884",        // numeric post id
//             code: "C_1g_CcypKE",              // shortcode for URL
//             taken_at: 1726185077,             // Unix seconds (real ts)
//             like_count: 158,
//             user: { username, profile_pic_url, … },
//             text_post_app_info: {
//               direct_reply_count, repost_count, quote_count,
//               reshare_count, text_fragments: { fragments: [...] }
//             },
//             caption: { text: "…" },           // simpler than text_fragments
//             image_versions2: { candidates: [...] },  // images
//             video_versions: null | [...],     // videos when present
//             original_height, original_width,
//             …
//           }}]
//         }
//       },
//       cursor: ""                              // pagination cursor
//     }, …
//   ]
//
// Cost: 1 unit per returned post (per OpenAPI). Threads caps at
// ~10-20 posts per call. Single HTTP call — no pagination loop, since
// EnsembleData says "Run the API multiple times per day to get more
// posts" (daily-quota model, not cursor model). pages_fetched = 1.

export async function searchThreadsKeyword(args: {
  query: string;       // keyword (no leading '#' handling — Threads
                       // search is keyword-text, not hashtag-only)
  max_results: number; // 1..100, clamped (Threads usually returns ≤20)
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
  const wanted = Math.max(1, Math.min(args.max_results, 100));
  const query = args.query.trim();
  if (!query) {
    return {
      candidates: [],
      units_estimated: 0,
      pages_fetched: 0,
      error: "parse_error",
    };
  }

  const url = new URL(`${ENSEMBLEDATA_BASE}/threads/keyword/search`);
  url.searchParams.set("name", query);
  url.searchParams.set("sorting", "0"); // 0 = TOP, 1 = RECENT
  url.searchParams.set("token", token);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url.toString(), { signal: ctrl.signal });
  } catch {
    clearTimeout(timer);
    return {
      candidates: [],
      units_estimated: 0,
      pages_fetched: 0,
      error: "transient",
    };
  }
  clearTimeout(timer);

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  if (res.status === 429) {
    return {
      candidates: [],
      units_estimated: 0,
      pages_fetched: 1,
      raw_payload: body,
      error: "rate_limited",
    };
  }
  if (res.status === 404) {
    return {
      candidates: [],
      units_estimated: 0,
      pages_fetched: 1,
      raw_payload: body,
      error: "not_found",
    };
  }
  if (res.status >= 500 || !res.ok) {
    return {
      candidates: [],
      units_estimated: 0,
      pages_fetched: 1,
      raw_payload: body,
      error: "transient",
    };
  }

  const candidates = parseThreadsKeywordPage(body);
  if (candidates === null) {
    return {
      candidates: [],
      units_estimated: 1,
      pages_fetched: 1,
      raw_payload: body,
      error: "parse_error",
    };
  }

  // Dedupe by pk and cap at wanted.
  const seen = new Set<string>();
  const unique: Candidate[] = [];
  for (const c of candidates) {
    if (seen.has(c.post_id)) continue;
    seen.add(c.post_id);
    unique.push(c);
    if (unique.length >= wanted) break;
  }

  // Threads charges 1 unit per returned post (raw count, pre-dedupe).
  const units_estimated = Math.max(1, candidates.length);

  let error: SearchResult["error"];
  if (unique.length === 0) error = "parse_error";

  return {
    candidates: unique,
    units_estimated,
    pages_fetched: 1,
    raw_payload: body,
    error,
  };
}

// Exported for fixture-based testing. Returns null on shape mismatch
// (so the searcher can flag parse_error). Empty array means valid
// shape but no items.
export function parseThreadsKeywordPage(body: unknown): Candidate[] | null {
  if (!body || typeof body !== "object") return null;
  const root = body as Record<string, unknown>;
  const data = root.data;
  if (!Array.isArray(data)) return null;

  const out: Candidate[] = [];
  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    const node = (item as Record<string, unknown>).node;
    if (!node || typeof node !== "object") continue;
    const thread = (node as Record<string, unknown>).thread;
    if (!thread || typeof thread !== "object") continue;
    const items = (thread as Record<string, unknown>).thread_items;
    if (!Array.isArray(items) || items.length === 0) continue;
    // Each thread_items entry contains a post; keyword search returns
    // a single post per thread node, but iterate to be safe.
    for (const ti of items) {
      if (!ti || typeof ti !== "object") continue;
      const post = (ti as Record<string, unknown>).post;
      if (!post || typeof post !== "object") continue;
      const c = parseThreadsPost(post as Record<string, unknown>);
      if (c) out.push(c);
    }
  }
  return out;
}

function parseThreadsPost(p: Record<string, unknown>): Candidate | null {
  const pk = stringValue(p.pk);
  const code = stringValue(p.code);
  if (!pk || !code) return null;

  const user = (p.user ?? {}) as Record<string, unknown>;
  const username = stringValue(user.username);
  if (!username) return null; // need username for canonical URL

  // Caption: caption.text is the cleanest form; falls back to
  // concatenated text_fragments.fragments[].plaintext if absent.
  const captionObj = p.caption;
  let caption =
    (captionObj && typeof captionObj === "object"
      ? stringValue((captionObj as Record<string, unknown>).text)
      : null) ?? "";
  if (!caption) {
    const tpai = p.text_post_app_info;
    if (tpai && typeof tpai === "object") {
      const tf = (tpai as Record<string, unknown>).text_fragments;
      if (tf && typeof tf === "object") {
        const fragments = (tf as Record<string, unknown>).fragments;
        if (Array.isArray(fragments)) {
          const parts: string[] = [];
          for (const f of fragments) {
            if (f && typeof f === "object") {
              const pt = stringValue((f as Record<string, unknown>).plaintext);
              if (pt) parts.push(pt);
            }
          }
          caption = parts.join("");
        }
      }
    }
  }

  // taken_at is a real Unix-seconds timestamp.
  const taken_at = numberValue(p.taken_at) ?? 0;

  // Engagement: Threads exposes like_count + reply/repost/quote counts
  // but no view_count. Set view_count=0 for consistency with the rest
  // of the Candidate shape (UI's "Views desc" sort puts these at the
  // bottom, which is correct given we have no signal there).
  const like_count = numberValue(p.like_count);
  const tpai = (p.text_post_app_info ?? {}) as Record<string, unknown>;
  const direct_reply_count = numberValue(tpai.direct_reply_count);
  const repost_count = numberValue(tpai.repost_count);
  const quote_count = numberValue(tpai.quote_count);

  // Thumbnail: image_versions2.candidates[0]?.url for image/text posts;
  // video_versions[0]?.url is the video URL itself, not a thumbnail —
  // skip in v1, leave thumbnail null on video-only posts.
  const iv2 = (p.image_versions2 ?? {}) as Record<string, unknown>;
  const candidates = iv2.candidates;
  let thumbnail_url: string | null = null;
  if (Array.isArray(candidates) && candidates.length > 0) {
    const first = candidates[0];
    if (first && typeof first === "object") {
      thumbnail_url = stringValue((first as Record<string, unknown>).url);
    }
  }

  return {
    platform: "threads",
    post_id: pk,
    post_url: `https://www.threads.net/@${username}/post/${code}`,
    caption,
    posted_at: taken_at,
    posted_relative: null, // taken_at is precise; UI computes relative
    view_count: 0,
    like_count,
    comment_count: direct_reply_count,
    share_count: repost_count,
    save_count: quote_count, // quote_count is the closest semantic
    author_handle: username,
    author_display_name: null, // Threads response in this example
                               // doesn't include a full_name field
    author_url: `https://www.threads.net/@${username}`,
    author_avatar_url: stringValue(user.profile_pic_url),
    thumbnail_url,
    hashtags: [],
    // is_video is required by the Candidate shape (filter assertion
    // for TikTok). Threads candidates may be text-only posts, image
    // carousels, or videos; the "is_video" tag here is a misnomer for
    // Threads — kept as `true` literally to satisfy the type but
    // doesn't reflect actual media. Smell-test surface treats all
    // returned posts as fan_edit-eligible candidates.
    is_video: true,
  };
}
