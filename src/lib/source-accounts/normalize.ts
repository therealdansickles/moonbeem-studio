// Source Accounts — pure normalization + candidate-extraction + cursor logic.
//
// Everything here is dependency-free (no Next, no supabase, no fetch) so it can
// be unit-tested directly with `npx tsx` against fixture nodes. The Instagram
// response shape is the web-GraphQL form confirmed in the recon:
//
//   { data: { count, posts: [ { node: {...} } ], last_cursor } }
//
// with per-node fields (all under `node`):
//   shortcode                        -> post_url https://www.instagram.com/p/<code>/
//   edge_media_to_caption.edges[0].node.text  -> caption
//   taken_at_timestamp               -> taken_at (unix seconds)
//   __typename (GraphVideo|GraphSidecar|GraphImage) + is_video + product_type
//   video_view_count                 -> views (videos only; absent on image/carousel)
//   edge_media_preview_like.count    -> likes (edge_liked_by.count is a fallback;
//                                       -1 when like_and_view_counts_disabled -> null)
//   pinned_for_users: []             -> non-empty means the post is PINNED (hoisted
//                                       to the front, OUT of chronological order)

export type RawNode = Record<string, unknown>;

export type NormalizedPost = {
  shortcode: string;
  post_url: string;
  caption: string | null;
  taken_at: number | null; // unix seconds
  is_pinned: boolean;
  media_type: string | null; // 'video' | 'carousel' | 'image' | lowercased __typename
  video_view_count: number | null;
  like_count: number | null;
};

export type TitleCandidate = { name: string; year: number | null };

// ---------------------------------------------------------------------------
// safe getters (no external deps)
// ---------------------------------------------------------------------------

function get(obj: unknown, path: (string | number)[]): unknown {
  let cur: unknown = obj;
  for (const k of path) {
    if (cur == null) return undefined;
    if (typeof k === "number") {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[k];
    } else if (typeof cur === "object") {
      cur = (cur as Record<string, unknown>)[k];
    } else {
      return undefined;
    }
  }
  return cur;
}

// Integer coerce with the -1 sentinel guard. Instagram returns -1 for counts
// hidden by like_and_view_counts_disabled — that is an intentional hide, NOT a
// real zero, so it maps to null (mirrors the existing view-tracking client).
export function intOrNullNonNeg(v: unknown): number | null {
  let n: number | null = null;
  if (typeof v === "number" && Number.isFinite(v)) n = v;
  else if (typeof v === "string" && v.trim() !== "") {
    const p = parseInt(v, 10);
    if (Number.isFinite(p)) n = p;
  }
  if (n === null) return null;
  if (n < 0) return null; // -1 (or any negative) sentinel -> null
  return n;
}

function nonEmptyString(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

// ---------------------------------------------------------------------------
// field extractors
// ---------------------------------------------------------------------------

export function captionFromNode(node: RawNode): string | null {
  const text = get(node, ["edge_media_to_caption", "edges", 0, "node", "text"]);
  return nonEmptyString(text);
}

export function mediaTypeFromNode(node: RawNode): string | null {
  const typename = node["__typename"];
  if (typeof typename === "string") {
    switch (typename) {
      case "GraphVideo":
        return "video";
      case "GraphSidecar":
        return "carousel";
      case "GraphImage":
        return "image";
      default:
        return typename.toLowerCase();
    }
  }
  // Fallback to is_video when __typename is missing.
  if (node["is_video"] === true) return "video";
  if (node["is_video"] === false) return "image";
  return null;
}

export function isPinnedNode(node: RawNode): boolean {
  const pfu = node["pinned_for_users"];
  return Array.isArray(pfu) && pfu.length > 0;
}

export function likeCountFromNode(node: RawNode): number | null {
  // Primary shape confirmed in recon; edge_liked_by is a documented fallback.
  const primary = get(node, ["edge_media_preview_like", "count"]);
  const viaPrimary = intOrNullNonNeg(primary);
  if (viaPrimary !== null || primary !== undefined) return viaPrimary;
  return intOrNullNonNeg(get(node, ["edge_liked_by", "count"]));
}

// Returns null (skip) when the node has no shortcode — without it we can neither
// build a post_url nor dedup the queue row.
export function normalizeInstagramNode(node: RawNode): NormalizedPost | null {
  const shortcode = nonEmptyString(node["shortcode"]);
  if (!shortcode) return null;

  const takenRaw = node["taken_at_timestamp"];
  const taken_at =
    typeof takenRaw === "number" && Number.isFinite(takenRaw)
      ? takenRaw
      : typeof takenRaw === "string" && takenRaw.trim() !== "" && Number.isFinite(Number(takenRaw))
        ? Number(takenRaw)
        : null;

  return {
    shortcode,
    post_url: `https://www.instagram.com/p/${shortcode}/`,
    caption: captionFromNode(node),
    taken_at,
    is_pinned: isPinnedNode(node),
    media_type: mediaTypeFromNode(node),
    video_view_count: intOrNullNonNeg(node["video_view_count"]),
    like_count: likeCountFromNode(node),
  };
}

// ---------------------------------------------------------------------------
// incremental cursor — recon flag 3
// ---------------------------------------------------------------------------
//
// The next run's oldest_timestamp must be the newest NON-pinned post we've seen.
// Pinned posts are hoisted to the front out of chronological order, so a naive
// max(taken_at) over ALL posts (or "the first post") can be an old pinned post
// and would corrupt the cursor. We deliberately exclude pinned posts here.

export function computeIncrementalCursor(posts: NormalizedPost[]): number | null {
  let max: number | null = null;
  for (const p of posts) {
    if (p.is_pinned) continue;
    if (p.taken_at == null) continue;
    if (max === null || p.taken_at > max) max = p.taken_at;
  }
  return max;
}

// ---------------------------------------------------------------------------
// caption -> title candidates
// ---------------------------------------------------------------------------
//
// v1 extracts "<Title> (<optional director>, <YYYY>)" / "<Title> (<YYYY>)"
// patterns — the high-signal form docstowatch uses in its listicles and single-
// film posts. Each candidate carries the parsed year so the matcher can apply
// its year +/- 1 window. Candidates are de-duplicated case-insensitively.
//
// Known v1 limitation (reported): a listicle post yields MANY candidates but the
// queue stores ONE matched_title_id per post (best confidence wins) — the other
// titles in a multi-film post are not queued in v1. A caption with no
// parenthetical year yields no candidates -> the post lands as 'no_match'.

const YEAR_PAREN_RE =
  // title text (non-greedy, same line) + "(" + optional "director, " + YYYY + ")"
  /([^\n(]{1,120}?)\s*\((?:[^()]*?,\s*)?((?:19|20)\d{2})\)/g;

const LEADING_LIST_NUMBER_RE = /^\s*\d{1,3}[.)\-:]\s*/;
// Strip leading non-letter/digit clutter (emojis, bullets, quotes, whitespace).
const LEADING_CLUTTER_RE = /^[^\p{L}\p{N}]+/u;
const TRAILING_CLUTTER_RE = /[\s"'“”·:;,\-–—]+$/;

function cleanTitle(raw: string): string {
  let s = raw.replace(/\s+/g, " ").trim();
  s = s.replace(LEADING_LIST_NUMBER_RE, "");
  s = s.replace(LEADING_CLUTTER_RE, "");
  s = s.replace(TRAILING_CLUTTER_RE, "");
  return s.trim();
}

export function extractTitleCandidates(caption: string | null): TitleCandidate[] {
  if (!caption || typeof caption !== "string") return [];
  const out: TitleCandidate[] = [];
  const seen = new Set<string>();
  // Reset lastIndex on the shared regex before iterating.
  YEAR_PAREN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = YEAR_PAREN_RE.exec(caption)) !== null) {
    const name = cleanTitle(m[1]);
    const year = Number.parseInt(m[2], 10);
    if (name.length < 2) continue; // reject noise fragments
    if (!Number.isFinite(year)) continue;
    const key = `${name.toLowerCase()}|${year}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, year });
  }
  return out;
}
