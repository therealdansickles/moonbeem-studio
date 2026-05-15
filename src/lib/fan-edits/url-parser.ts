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
