// Shared URL → platform/id/handle parser used by the single-URL and
// bulk-CSV admin fan-edit upload flows.
//
// Wraps `parseShortcodeFromUrl()` from src/lib/ensembledata/client.ts
// rather than duplicating the regexes. Adds two things on top:
//   1. Platform detection from the URL host (the underlying parser
//      requires the caller to know the platform already)
//   2. Handle extraction from the URL path for TikTok and Twitter,
//      where the handle is the first segment. YouTube doesn't carry
//      the channel handle in the watch URL; Instagram requires an
//      EnsembleData lookup. Both return null here — callers must
//      gather the handle elsewhere.
//
// Dual-copy concern: parseShortcodeFromUrl lives in BOTH
// src/lib/ensembledata/client.ts and supabase/functions/view-tracking/
// ensemble.ts. We're consuming the src/ copy only; the Edge Function
// is not affected by this module.

import { parseShortcodeFromUrl } from "@/lib/ensembledata/client";

export type Platform = "tiktok" | "instagram" | "twitter" | "youtube";

export type ParsedFanEditUrl = {
  platform: Platform;
  contentId: string;
  // Best-effort handle without exclamation: TikTok /@handle, Twitter
  // /handle/status/... YouTube and Instagram are null at parse time.
  handle: string | null;
  // Canonicalized (host + path, no query/fragment). Used as the
  // embed_url stored in fan_edits.
  normalizedUrl: string;
};

const TIKTOK_HOSTS = new Set([
  "tiktok.com",
  "www.tiktok.com",
  "m.tiktok.com",
  "vm.tiktok.com",
  "vt.tiktok.com",
]);
// Short-link hosts whose path doesn't carry the canonical numeric
// video id — needs a redirect-follow to resolve. Mobile-share URLs
// always land here.
const TIKTOK_SHORT_HOSTS = new Set([
  "vm.tiktok.com",
  "vt.tiktok.com",
]);
const INSTAGRAM_HOSTS = new Set([
  "instagram.com",
  "www.instagram.com",
]);
const TWITTER_HOSTS = new Set([
  "twitter.com",
  "www.twitter.com",
  "x.com",
  "www.x.com",
  "mobile.twitter.com",
]);
const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "youtu.be",
  "music.youtube.com",
]);

function detectPlatform(host: string): Platform | null {
  const h = host.toLowerCase();
  if (TIKTOK_HOSTS.has(h)) return "tiktok";
  if (INSTAGRAM_HOSTS.has(h)) return "instagram";
  if (TWITTER_HOSTS.has(h)) return "twitter";
  if (YOUTUBE_HOSTS.has(h)) return "youtube";
  return null;
}

function extractHandle(platform: Platform, pathname: string): string | null {
  if (platform === "tiktok") {
    // /@handle/video/... or /@handle/photo/...
    const m = pathname.match(/^\/@([^/]+)\//);
    return m ? m[1] : null;
  }
  if (platform === "twitter") {
    // /<handle>/status/<id>
    const m = pathname.match(/^\/([^/]+)\/status\/\d+/);
    if (m && m[1] !== "i") return m[1];
    return null;
  }
  return null;
}

// Result of an async URL resolve. `url` is the canonical form ready
// for parseFanEditUrl; on failure, `reason` is a user-facing string.
export type ResolveResult =
  | { ok: true; url: string }
  | { ok: false; reason: string };

// Detects TikTok mobile-share URLs that need a redirect-follow to
// reach the canonical /@handle/video/{id} form. The synchronous
// parser can't extract a post_id from these — short-link slugs are
// not the canonical numeric id.
//
// Three patterns in the wild:
//   - vm.tiktok.com/<slug>
//   - vt.tiktok.com/<slug>
//   - (www.)tiktok.com/t/<slug>
function isTikTokShortLink(parsed: URL): boolean {
  const host = parsed.host.toLowerCase();
  if (TIKTOK_SHORT_HOSTS.has(host)) return true;
  if (TIKTOK_HOSTS.has(host) && /^\/t\//.test(parsed.pathname)) return true;
  return false;
}

const RESOLVE_TIMEOUT_MS = 3000;
const RESOLVE_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// Resolve a fan-edit URL to its canonical form. Short-link patterns
// trigger a HEAD with redirect:follow — TikTok returns 403 on the
// body but response.url already carries the final URL after the
// redirect chain. Non-short-link URLs are a no-op fast path.
//
// 3s timeout per spec. Caller should treat failure as "unrecognized
// URL" + surface `reason` so the admin can paste the canonical form
// manually.
export async function resolveFanEditUrl(
  rawUrl: string,
): Promise<ResolveResult> {
  if (!rawUrl || typeof rawUrl !== "string") {
    return { ok: false, reason: "invalid URL" };
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return { ok: false, reason: "invalid URL" };
  }
  if (!isTikTokShortLink(parsed)) {
    return { ok: true, url: rawUrl.trim() };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), RESOLVE_TIMEOUT_MS);
  try {
    const res = await fetch(rawUrl.trim(), {
      method: "HEAD",
      redirect: "follow",
      signal: ctrl.signal,
      headers: {
        "User-Agent": RESOLVE_UA,
        "Accept-Language": "en-US,en;q=0.5",
      },
    });
    clearTimeout(timer);
    // 4xx/5xx body refusal is fine — response.url still reflects the
    // post-redirect URL. What we DO care about is the URL ending up
    // on a canonical TikTok video path.
    const finalUrl = res.url;
    let finalParsed: URL;
    try {
      finalParsed = new URL(finalUrl);
    } catch {
      return {
        ok: false,
        reason:
          "TikTok short-link resolved to an invalid URL; try the canonical URL.",
      };
    }
    if (isTikTokShortLink(finalParsed)) {
      // Redirect went somewhere we still can't parse (e.g. login
      // wall). Treat as unresolved.
      return {
        ok: false,
        reason:
          "TikTok short-link did not resolve to a canonical video URL; try the canonical URL.",
      };
    }
    return { ok: true, url: finalUrl };
  } catch (err) {
    clearTimeout(timer);
    const name = (err as Error).name;
    if (name === "AbortError" || name === "TimeoutError") {
      return {
        ok: false,
        reason: "TikTok short-link failed to resolve (timeout); try the canonical URL.",
      };
    }
    return {
      ok: false,
      reason: "TikTok short-link failed to resolve; try the canonical URL.",
    };
  }
}

export function parseFanEditUrl(rawUrl: string): ParsedFanEditUrl | null {
  if (!rawUrl || typeof rawUrl !== "string") return null;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return null;
  }
  const platform = detectPlatform(parsed.host);
  if (!platform) return null;

  const contentId = parseShortcodeFromUrl(rawUrl, platform);
  if (!contentId) return null;

  const handle = extractHandle(platform, parsed.pathname);

  // Normalize to host + path (drop query + fragment + trailing slash)
  // so the same post submitted via shared link vs. browser-tab URL
  // dedupes correctly downstream.
  const normalizedUrl =
    `https://${parsed.host}${parsed.pathname.replace(/\/$/, "")}`;

  return { platform, contentId, handle, normalizedUrl };
}
