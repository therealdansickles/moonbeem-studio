// Source Accounts — EnsembleData fetch client (Instagram user endpoints).
//
// Follows the established view-tracking pattern in src/lib/ensembledata/client.ts
// (same ENSEMBLEDATA_TOKEN env, same base URL, same AbortController timeout +
// error categorisation) rather than duplicating it. client.ts owns the per-POST
// lookups used by view-tracking; this module owns the per-ACCOUNT endpoints the
// scraper needs, which client.ts does not expose:
//
//   GET /instagram/user/info?username=<handle>&token=  -> resolve handle -> pk
//   GET /instagram/user/posts?user_id=<pk>&depth=<n>[&oldest_timestamp=<unix>]&token=
//   GET /customer/get-used-units?date=YYYY-MM-DD&token=  -> shared daily unit meter
//
// Endpoint shapes confirmed in the recon (2026-07-02). Units: user/posts costs
// ~1 unit per post returned; depth=N auto-paginates ~N*10 posts server-side in a
// single call; get-used-units is free. The token is SHARED with the live
// view-tracking cron — see getUsedUnits + the route's budget guard.
//
// PARK-DON'T-CORRUPT: every response is shape-checked. Anything unexpected (non-200,
// non-JSON, missing data envelope) returns { ok: false, error } so the caller can
// ABORT the scrape instead of writing partial/garbage rows.

import { normalizeInstagramNode, type NormalizedPost } from "./normalize";

const ENSEMBLEDATA_BASE = "https://ensembledata.com/apis"; // mirrors client.ts
const RESOLVE_TIMEOUT_MS = 10000;
const UNITS_TIMEOUT_MS = 10000;
// user/posts auto-paginates server-side (depth pages) and returns a large payload,
// so it needs a much longer ceiling than the per-post client's 5s.
const POSTS_TIMEOUT_MS = 60000;

export type EdErrorCategory =
  | "missing_token"
  | "not_found"
  | "rate_limited"
  | "transient"
  | "bad_shape";

export type EdError = { ok: false; error: EdErrorCategory; detail: string; status?: number };

export type ResolveResult =
  | {
      ok: true;
      userId: string;
      username: string | null;
      fullName: string | null;
      isPrivate: boolean;
      isVerified: boolean;
    }
  | EdError;

export type FetchPostsResult =
  | {
      ok: true;
      posts: NormalizedPost[];
      rawCount: number | null; // data.count — total posts on the account
      fetchedCount: number; // nodes returned this call (pre-normalization)
      lastCursor: string | null;
      // true when we did NOT pass oldest_timestamp yet fetched fewer than the
      // account's total — i.e. depth capped the backfill and a tail remains.
      truncated: boolean;
    }
  | EdError;

export type UsedUnitsResult =
  | { ok: true; perPlatform: Record<string, number>; instagram: number; total: number }
  | EdError;

function getToken(): string | null {
  const t = process.env.ENSEMBLEDATA_TOKEN;
  return t && t.trim() !== "" ? t : null;
}

async function edGet(
  url: string,
  timeoutMs: number,
): Promise<{ ok: true; status: number; body: unknown } | EdError> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, { signal: ctrl.signal });
  } catch (e) {
    clearTimeout(timer);
    return {
      ok: false,
      error: "transient",
      detail: e instanceof Error ? e.message : "network/abort",
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
    return { ok: false, error: "rate_limited", detail: "429 from EnsembleData", status: 429 };
  }
  if (res.status === 404) {
    return { ok: false, error: "not_found", detail: "404 from EnsembleData", status: 404 };
  }
  if (res.status < 200 || res.status >= 300) {
    // 472 (ED's invalid-input code), 5xx, other 4xx — all park.
    return {
      ok: false,
      error: res.status >= 500 ? "transient" : "bad_shape",
      detail: `HTTP ${res.status} from EnsembleData`,
      status: res.status,
    };
  }
  if (body == null || typeof body !== "object") {
    return { ok: false, error: "bad_shape", detail: "response body was not a JSON object" };
  }
  return { ok: true, status: res.status, body };
}

// Resolve @handle -> numeric user id via /instagram/user/info. The pk lives at
// data.pk (== data.pk_id in the recon).
export async function resolveInstagramUserId(handle: string): Promise<ResolveResult> {
  const token = getToken();
  if (!token) return { ok: false, error: "missing_token", detail: "ENSEMBLEDATA_TOKEN unset" };
  const clean = handle.replace(/^@+/, "").trim();
  if (!clean) return { ok: false, error: "bad_shape", detail: "empty handle" };

  const url = `${ENSEMBLEDATA_BASE}/instagram/user/info?username=${encodeURIComponent(
    clean,
  )}&token=${encodeURIComponent(token)}`;
  const r = await edGet(url, RESOLVE_TIMEOUT_MS);
  if (!r.ok) return r;

  const data = (r.body as Record<string, unknown>).data;
  const user =
    data && typeof data === "object"
      ? ((data as Record<string, unknown>).user &&
        typeof (data as Record<string, unknown>).user === "object"
          ? ((data as Record<string, unknown>).user as Record<string, unknown>)
          : (data as Record<string, unknown>))
      : null;
  if (!user) return { ok: false, error: "bad_shape", detail: "no data.user in user/info" };

  const pkRaw = user.pk ?? user.pk_id ?? user.id;
  const userId =
    typeof pkRaw === "number"
      ? String(pkRaw)
      : typeof pkRaw === "string" && pkRaw.trim() !== ""
        ? pkRaw.trim()
        : null;
  if (!userId) return { ok: false, error: "bad_shape", detail: "no pk in user/info" };

  return {
    ok: true,
    userId,
    username: typeof user.username === "string" ? user.username : null,
    fullName: typeof user.full_name === "string" ? user.full_name : null,
    isPrivate: user.is_private === true,
    isVerified: user.is_verified === true,
  };
}

// Fetch (and normalize) a user's posts. depth=maxPages auto-paginates ~10 posts
// per depth in one call. oldest_timestamp (unix seconds) stops server-side
// pagination once older posts are reached — the incremental path passes the
// account's cursor_max_taken_at here. Pinned posts are ALWAYS returned regardless
// of oldest_timestamp; the caller dedups (unique shortcode) and computes the next
// cursor from non-pinned posts only.
export async function fetchInstagramPosts(
  userId: string,
  opts: { maxPages: number; oldestTimestamp?: number | null },
): Promise<FetchPostsResult> {
  const token = getToken();
  if (!token) return { ok: false, error: "missing_token", detail: "ENSEMBLEDATA_TOKEN unset" };

  const depth = Math.max(1, Math.floor(opts.maxPages));
  let url = `${ENSEMBLEDATA_BASE}/instagram/user/posts?user_id=${encodeURIComponent(
    userId,
  )}&depth=${depth}&token=${encodeURIComponent(token)}`;
  if (opts.oldestTimestamp != null && Number.isFinite(opts.oldestTimestamp)) {
    url += `&oldest_timestamp=${Math.floor(opts.oldestTimestamp)}`;
  }

  const r = await edGet(url, POSTS_TIMEOUT_MS);
  if (!r.ok) return r;

  const data = (r.body as Record<string, unknown>).data;
  if (!data || typeof data !== "object") {
    return { ok: false, error: "bad_shape", detail: "no data envelope in user/posts" };
  }
  const rawPosts = (data as Record<string, unknown>).posts;
  if (!Array.isArray(rawPosts)) {
    return { ok: false, error: "bad_shape", detail: "data.posts is not an array" };
  }
  const rawCountVal = (data as Record<string, unknown>).count;
  const rawCount = typeof rawCountVal === "number" ? rawCountVal : null;
  const lastCursorVal = (data as Record<string, unknown>).last_cursor;
  const lastCursor = typeof lastCursorVal === "string" && lastCursorVal ? lastCursorVal : null;

  const posts: NormalizedPost[] = [];
  for (const entry of rawPosts) {
    if (!entry || typeof entry !== "object") continue;
    // GraphQL edge shape: { node: {...} }. Tolerate a bare node too.
    const node =
      "node" in (entry as Record<string, unknown>)
        ? (entry as Record<string, unknown>).node
        : entry;
    if (!node || typeof node !== "object") continue;
    const n = normalizeInstagramNode(node as Record<string, unknown>);
    if (n) posts.push(n);
  }

  const fetchedCount = rawPosts.length;
  const truncated =
    opts.oldestTimestamp == null && rawCount != null && fetchedCount < rawCount;

  return { ok: true, posts, rawCount, fetchedCount, lastCursor, truncated };
}

// The shared daily unit meter. Returns per-platform usage + the instagram figure
// and an all-platform total (the plan pool is shared across platforms and with
// the live view-tracking cron). Free (0 units).
export async function getUsedUnits(date: string): Promise<UsedUnitsResult> {
  const token = getToken();
  if (!token) return { ok: false, error: "missing_token", detail: "ENSEMBLEDATA_TOKEN unset" };

  const url = `${ENSEMBLEDATA_BASE}/customer/get-used-units?date=${encodeURIComponent(
    date,
  )}&token=${encodeURIComponent(token)}`;
  const r = await edGet(url, UNITS_TIMEOUT_MS);
  if (!r.ok) return r;

  const data = (r.body as Record<string, unknown>).data;
  if (!data || typeof data !== "object") {
    return { ok: false, error: "bad_shape", detail: "no data in get-used-units" };
  }
  const perPlatform: Record<string, number> = {};
  let total = 0;
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    if (typeof v === "number" && Number.isFinite(v)) {
      perPlatform[k] = v;
      total += v;
    }
  }
  return { ok: true, perPlatform, instagram: perPlatform.instagram ?? 0, total };
}
