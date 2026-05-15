// Thumbnail proxy: download a social-network CDN image (Instagram
// fbcdn.net, TikTok tiktokcdn-us.com, etc.) with the appropriate
// Referer header and upload to R2 under a stable per-post key, so
// the in-app <img src> doesn't depend on the original CDN's
// hotlinking rules or token expirations.
//
// Idempotent: the key embeds (platform, post_id), so a second call
// for the same post is a no-op upload (S3 PUT overwrites with the
// same bytes; we could HEAD-check first but the cost is small).
//
// Returns the R2 public URL on success. On any fetch/upload failure
// returns null — caller can fall back to storing the original CDN
// URL and accept that some surfaces will show a broken image
// (better than blocking the insert).

import { PutObjectCommand } from "@aws-sdk/client-s3";
import { getR2Client, getR2Bucket } from "@/lib/r2/client";
import { buildPublicUrl } from "@/lib/r2/upload";
import type { Platform } from "./url-parser";

const FETCH_TIMEOUT_MS = 8000;

function refererFor(platform: Platform): string {
  if (platform === "instagram") return "https://www.instagram.com/";
  if (platform === "tiktok") return "https://www.tiktok.com/";
  if (platform === "twitter") return "https://x.com/";
  return "https://www.youtube.com/";
}

function userAgent(): string {
  // A real-browser-ish UA. IG's fbcdn refuses obvious bots.
  return "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
}

function extFromContentType(ct: string | null): string {
  if (!ct) return "jpg";
  if (ct.includes("png")) return "png";
  if (ct.includes("webp")) return "webp";
  if (ct.includes("gif")) return "gif";
  return "jpg";
}

export function buildThumbnailKey(
  platform: Platform,
  postId: string,
  ext: string,
): string {
  return `fan-edits/thumbnails/${platform}-${postId}.${ext}`;
}

export async function proxyThumbnailToR2(args: {
  platform: Platform;
  postId: string;
  thumbnailUrl: string;
}): Promise<string | null> {
  const { platform, postId, thumbnailUrl } = args;
  if (!thumbnailUrl) return null;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(thumbnailUrl, {
      signal: ctrl.signal,
      headers: {
        Referer: refererFor(platform),
        "User-Agent": userAgent(),
        Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      },
    });
  } catch (err) {
    console.warn("[thumbnail-proxy] fetch error", {
      platform,
      postId,
      error: err instanceof Error ? err.message : String(err),
    });
    clearTimeout(timer);
    return null;
  }
  clearTimeout(timer);

  if (!res.ok) {
    console.warn("[thumbnail-proxy] non-OK status", {
      platform,
      postId,
      status: res.status,
    });
    return null;
  }

  const contentType = res.headers.get("content-type");
  if (contentType && !contentType.startsWith("image/")) {
    console.warn("[thumbnail-proxy] non-image content-type", {
      platform,
      postId,
      contentType,
    });
    return null;
  }

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength === 0) {
    console.warn("[thumbnail-proxy] empty body", { platform, postId });
    return null;
  }

  const ext = extFromContentType(contentType);
  const key = buildThumbnailKey(platform, postId, ext);

  try {
    const client = getR2Client();
    await client.send(
      new PutObjectCommand({
        Bucket: getR2Bucket(),
        Key: key,
        Body: buf,
        ContentType: contentType ?? "image/jpeg",
        // Long TTL — content is immutable (key embeds the post id).
        CacheControl: "public, max-age=31536000, immutable",
      }),
    );
  } catch (err) {
    console.warn("[thumbnail-proxy] R2 upload failed", {
      platform,
      postId,
      key,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  return buildPublicUrl(key);
}
