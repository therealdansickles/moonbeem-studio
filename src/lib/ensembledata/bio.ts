// EnsembleData public-profile lookups for Stage 2C bio verification.
//
// Each platform fetcher returns the bio text as a string, throwing
// on shape mismatch (so the caller can show "couldn't read bio,
// try again" rather than silently passing a wrong field). Field
// paths are best-effort plausible — the first real call against
// each endpoint will tell us if they're right; errors include the
// raw_payload preview so we can iterate quickly.

import type { SocialPlatform } from "@/lib/socials/handle";

const ENSEMBLEDATA_BASE = "https://ensembledata.com/apis";
const FETCH_TIMEOUT_MS = 8000;

async function fetchJson(url: string): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`upstream ${res.status}: ${txt.slice(0, 200)}`);
  }
  return res.json();
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

function shapeError(platform: string, body: unknown): Error {
  const preview = JSON.stringify(body).slice(0, 200);
  return new Error(`${platform} bio shape mismatch (preview: ${preview})`);
}

export async function fetchBio(
  platform: SocialPlatform,
  handle: string,
): Promise<string> {
  const token = process.env.ENSEMBLEDATA_TOKEN;
  if (!token) throw new Error("ENSEMBLEDATA_TOKEN missing");

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
  // Plausible: GET /tt/user/info?username=X → data.user.signature
  // (TikTok's term for bio is "signature"). Some endpoints wrap
  // the result in an array under data; check both.
  const url = `${ENSEMBLEDATA_BASE}/tt/user/info?username=${
    encodeURIComponent(handle)
  }&token=${encodeURIComponent(token)}`;
  const body = await fetchJson(url);
  const candidates: unknown[] = [
    get(body, ["data", "user", "signature"]),
    get(body, ["data", "0", "user", "signature"]),
    get(body, ["data", "userInfo", "user", "signature"]),
  ];
  for (const c of candidates) {
    if (typeof c === "string") return c;
  }
  throw shapeError("tiktok", body);
}

async function fetchInstagramBio(
  handle: string,
  token: string,
): Promise<string> {
  // Plausible: GET /instagram/user/info?username=X → data.biography
  // (or data.user.biography depending on endpoint shape).
  const url = `${ENSEMBLEDATA_BASE}/instagram/user/info?username=${
    encodeURIComponent(handle)
  }&token=${encodeURIComponent(token)}`;
  const body = await fetchJson(url);
  const candidates: unknown[] = [
    get(body, ["data", "biography"]),
    get(body, ["data", "user", "biography"]),
  ];
  for (const c of candidates) {
    if (typeof c === "string") return c;
  }
  throw shapeError("instagram", body);
}

async function fetchTwitterBio(
  handle: string,
  token: string,
): Promise<string> {
  // Plausible: GET /twitter/user/info?screen_name=X →
  // data.legacy.description. Mirrors the post endpoint's shape
  // (data.legacy.* for tweet engagement).
  const url = `${ENSEMBLEDATA_BASE}/twitter/user/info?screen_name=${
    encodeURIComponent(handle)
  }&token=${encodeURIComponent(token)}`;
  const body = await fetchJson(url);
  const candidates: unknown[] = [
    get(body, ["data", "legacy", "description"]),
    get(body, ["data", "description"]),
    get(body, ["data", "user", "legacy", "description"]),
  ];
  for (const c of candidates) {
    if (typeof c === "string") return c;
  }
  throw shapeError("twitter", body);
}
