import { PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getR2Bucket, getR2Client, getR2PublicUrl } from "./client";

const PRESIGN_TTL_SECONDS = 60 * 5;

export function buildContentDisposition(filename: string): string {
  const safeAscii = filename
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, "_")
    .replace(/["\\]/g, "_")
    .replace(/[\r\n]/g, "")
    .trim();
  const ascii = safeAscii || "download";
  const utf8 = encodeURIComponent(filename).replace(/['()]/g, escape);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

export async function generatePresignedUploadUrl(
  key: string,
  contentType: string,
  suggestedFilename: string,
): Promise<{ url: string; contentDisposition: string }> {
  const contentDisposition = buildContentDisposition(suggestedFilename);
  const cmd = new PutObjectCommand({
    Bucket: getR2Bucket(),
    Key: key,
    ContentType: contentType,
    ContentDisposition: contentDisposition,
  });
  const url = await getSignedUrl(getR2Client(), cmd, {
    expiresIn: PRESIGN_TTL_SECONDS,
  });
  return { url, contentDisposition };
}

export function buildPublicUrl(key: string): string {
  const base = getR2PublicUrl().replace(/\/$/, "");
  return `${base}/${key}`;
}

function safeExt(ext: string): string {
  return ext.replace(/^\./, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function buildClipKey(
  titleSlug: string,
  index: number,
  ext: string,
): string {
  return `clips/${titleSlug}/${index}.${safeExt(ext)}`;
}

export function buildStillKey(
  titleSlug: string,
  index: number,
  ext: string,
): string {
  return `stills/${titleSlug}/${index}.${safeExt(ext)}`;
}

// partners/<slug>/logo-<ms>.<ext>. Slug-based directory so the
// "create new partner" flow can upload before the partner row's id
// is known to the client. The Date.now() ms suffix makes each
// upload mint a NEW public URL — browsers and CDNs treat it as a
// fresh resource and don't serve stale bytes from a prior
// replacement (caught 2026-05-12 in Phase B smoke test on
// Magnolia: replacing /partners/magnolia-pictures/logo.png left
// the browser cache serving the morning's square 64 KB version
// even though R2 had the new 16:9 file). Mirrors the unique-key
// pattern used by fan_edits/<id>/thumb.jpg.
//
// Orphaned objects from prior uploads at partners/<slug>/logo-*.<ext>
// are NOT deleted here — a post-pitch reconciliation cron will
// purge keys that don't match a current partners.logo_url.
//
// If a slug is later changed via Edit Partner, the stored logo_url
// still resolves — we don't move the R2 object on slug change.
// Re-upload at the new slug to land bytes under that path.
export function buildPartnerLogoKey(slug: string, ext: string): string {
  return `partners/${slug}/logo-${Date.now()}.${safeExt(ext)}`;
}

// posters/<titleSlug>/<ms>.<ext>. The Date.now() ms suffix is load-bearing: it
// mints a NEW public URL on every replace so browsers/CDNs never serve stale
// bytes from a prior poster — the same cache-bust guard as buildPartnerLogoKey
// (after the 2026-05-12 stale-image bug), and the whole point of replacing a
// broken/fragile poster. Orphans at posters/<slug>/* are NOT purged here (a
// reconciliation cron handles that, matching the logo/clip retention pattern).
export function buildPosterKey(titleSlug: string, ext: string): string {
  return `posters/${titleSlug}/${Date.now()}.${safeExt(ext)}`;
}
