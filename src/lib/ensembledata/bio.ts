// EnsembleData public-profile lookups for Stage 2C bio verification.
//
// Verified endpoint shapes (2026-05-07, against real production data):
//   Instagram /apis/instagram/user/detailed-info?username=X
//     → data.biography. NOT /apis/instagram/user/info, which returns
//       only basic profile (pk, username, full_name, is_verified) and
//       no biography field.
//   TikTok    /apis/tt/user/info?username=X
//     → data.user.signature ("signature" is TikTok's term for bio).
//   Twitter   /apis/twitter/user/info?name=X
//     → data.legacy.description. The Twitter endpoint requires `name`,
//       NOT `screen_name` (returns 422 "field required: name" otherwise).
//
// On shape mismatch we log the full upstream body to console.error so
// Vercel function logs capture it for follow-up debugging — a
// 200-char in-message preview wasn't enough on the first iteration.
//
// Categorized error codes (caller maps to UI strings):
//   handle_not_found      — upstream 404 / empty data
//   platform_unavailable  — network error, timeout, or upstream 5xx
//   shape_mismatch        — response decoded but bio field absent
//   bio_empty             — response decoded with empty-string bio
//   token_missing         — server misconfiguration
//   rate_limited          — upstream 429

import type { SocialPlatform } from "@/lib/socials/handle";

const ENSEMBLEDATA_BASE = "https://ensembledata.com/apis";
const FETCH_TIMEOUT_MS = 8000;

export class BioFetchError extends Error {
  code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.code = code;
    this.name = "BioFetchError";
  }
}

type FetchResult =
  | { ok: true; body: unknown }
  | { ok: false; error: BioFetchError };

async function fetchJson(url: string): Promise<FetchResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, { signal: ctrl.signal });
  } catch (err) {
    clearTimeout(timer);
    return {
      ok: false,
      error: new BioFetchError(
        "platform_unavailable",
        `network: ${err instanceof Error ? err.message : "unknown"}`,
      ),
    };
  }
  clearTimeout(timer);

  if (res.status === 404) {
    return { ok: false, error: new BioFetchError("handle_not_found") };
  }
  if (res.status === 429) {
    return { ok: false, error: new BioFetchError("rate_limited") };
  }
  if (res.status >= 500) {
    return {
      ok: false,
      error: new BioFetchError("platform_unavailable", `upstream ${res.status}`),
    };
  }
  if (!res.ok) {
    // Other 4xx (validation, etc.) — log + treat as platform unavailable
    // for the user-facing error. Console captures the upstream payload.
    const txt = await res.text().catch(() => "");
    console.error(`[bio] upstream ${res.status} for ${url}: ${txt.slice(0, 500)}`);
    return {
      ok: false,
      error: new BioFetchError("platform_unavailable", `upstream ${res.status}`),
    };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return {
      ok: false,
      error: new BioFetchError("platform_unavailable", "non-json response"),
    };
  }
  return { ok: true, body };
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

function logShapeMismatch(platform: string, url: string, body: unknown) {
  // Full body to console.error so Vercel logs capture it. The thrown
  // error is intentionally short — UI maps the code to a user string.
  console.error(
    `[bio] shape_mismatch platform=${platform} url=${url} body=${
      JSON.stringify(body).slice(0, 4000)
    }`,
  );
}

export async function fetchBio(
  platform: SocialPlatform,
  handle: string,
): Promise<string> {
  const token = process.env.ENSEMBLEDATA_TOKEN;
  if (!token) throw new BioFetchError("token_missing");

  switch (platform) {
    case "tiktok":
      return fetchTikTokBio(handle, token);
    case "instagram":
      return fetchInstagramBio(handle, token);
    case "twitter":
      return fetchTwitterBio(handle, token);
  }
}

async function fetchTikTokBio(handle: string, token: string): Promise<string> {
  const url = `${ENSEMBLEDATA_BASE}/tt/user/info?username=${
    encodeURIComponent(handle)
  }&token=${encodeURIComponent(token)}`;
  const result = await fetchJson(url);
  if (!result.ok) throw result.error;
  const body = result.body;

  const sig = get(body, ["data", "user", "signature"]);
  if (typeof sig === "string") {
    if (sig.length === 0) throw new BioFetchError("bio_empty");
    return sig;
  }
  // Sometimes the user simply doesn't exist — EnsembleData may return
  // 200 with empty/missing data instead of 404. Treat as not found.
  const userObj = get(body, ["data", "user"]);
  if (!userObj) throw new BioFetchError("handle_not_found");

  logShapeMismatch("tiktok", url, body);
  throw new BioFetchError("shape_mismatch");
}

async function fetchInstagramBio(
  handle: string,
  token: string,
): Promise<string> {
  // /detailed-info is the variant that includes biography. /user/info
  // returns only basic profile and was the source of the 2026-05-07
  // 502 incident.
  const url = `${ENSEMBLEDATA_BASE}/instagram/user/detailed-info?username=${
    encodeURIComponent(handle)
  }&token=${encodeURIComponent(token)}`;
  const result = await fetchJson(url);
  if (!result.ok) throw result.error;
  const body = result.body;

  const bio = get(body, ["data", "biography"]);
  if (typeof bio === "string") {
    if (bio.length === 0) throw new BioFetchError("bio_empty");
    return bio;
  }
  if (!get(body, ["data"])) throw new BioFetchError("handle_not_found");

  logShapeMismatch("instagram", url, body);
  throw new BioFetchError("shape_mismatch");
}

async function fetchTwitterBio(
  handle: string,
  token: string,
): Promise<string> {
  // Twitter endpoint expects `name`, NOT `screen_name`. Wrong param
  // returns 422 with "field required: name".
  const url = `${ENSEMBLEDATA_BASE}/twitter/user/info?name=${
    encodeURIComponent(handle)
  }&token=${encodeURIComponent(token)}`;
  const result = await fetchJson(url);
  if (!result.ok) throw result.error;
  const body = result.body;

  const bio = get(body, ["data", "legacy", "description"]);
  if (typeof bio === "string") {
    if (bio.length === 0) throw new BioFetchError("bio_empty");
    return bio;
  }
  if (!get(body, ["data"])) throw new BioFetchError("handle_not_found");

  logShapeMismatch("twitter", url, body);
  throw new BioFetchError("shape_mismatch");
}
