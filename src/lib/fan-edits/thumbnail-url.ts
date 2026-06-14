// Classifies whether a stored fan-edit thumbnail_url points at our R2
// bucket — the only host we trust to render reliably in-app. Every
// thumbnail render surface guards on this so a null OR external/expired
// CDN url (e.g. a dead Instagram fbcdn geo-host) falls back to the title
// poster or a neutral placeholder instead of rendering a broken <img>.
//
// R2 public bucket is on *.r2.dev. If R2 moves to a custom domain,
// update this pattern — otherwise all thumbnails silently fall back to
// poster/placeholder.
//
// Pure: no env, no imports. Safe in BOTH client and server components —
// R2_PUBLIC_URL is server-only (no NEXT_PUBLIC_ variant), so the check
// cannot read the base from env on the client and instead matches the
// public r2.dev host.
// Type predicate (`url is string`): a true return guarantees url is a
// parseable non-null string, so callers can render `src={url}` directly
// inside the guarded branch without a non-null assertion.
export function isR2ThumbnailUrl(
  url: string | null | undefined,
): url is string {
  if (!url) return false;
  try {
    return new URL(url).host.endsWith(".r2.dev");
  } catch {
    return false;
  }
}
