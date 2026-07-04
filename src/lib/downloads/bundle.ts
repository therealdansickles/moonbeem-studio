// Pure helpers for the "download all clips / all stills" bundle feature.
// No I/O, no DOM — safe to import on both the authorize route (server) and
// the tab components (client), and fixtured in bundle.test.ts.
//
// Two jobs:
//   1. filenameForItem — derive a clean, correctly-extensioned download name
//      from a clip's label / still's alt_text + its content_type. Used by the
//      authorize route to name each manifest entry (the stills zip needs real
//      per-file names because R2's Content-Disposition is NOT CORS-exposed, so
//      the browser can't read the original name off the fetched bytes).
//   2. shouldZipStillsInMemory — the size guard. Stills are zipped in the
//      browser with fflate's in-memory zipSync; above the cap we fall back to
//      sequential downloads so a large set (e.g. the 103-image / ~595 MB
//      outlier) can't OOM the tab.

const EXT_BY_CONTENT_TYPE: Record<string, string> = {
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

// Map a MIME type to a file extension, or null if unknown. Tolerates a
// parameterized content-type ("image/jpeg; charset=binary") and casing.
export function extForContentType(
  contentType: string | null | undefined,
): string | null {
  if (!contentType) return null;
  const base = contentType.toLowerCase().split(";")[0]?.trim() ?? "";
  return EXT_BY_CONTENT_TYPE[base] ?? null;
}

// Derive a safe download filename. Strips characters that are unsafe in a
// zip entry / Content-Disposition, falls back to fallbackBase when the source
// name is empty, and appends the content-type extension (or fallbackExt if the
// type is unknown) — but never double-appends when the name already ends in it.
export function filenameForItem(
  base: string | null | undefined,
  contentType: string | null | undefined,
  fallbackBase: string,
  fallbackExt: string,
): string {
  const cleaned =
    (base ?? "").replace(/[^a-z0-9 ._-]/gi, "").trim() || fallbackBase;
  const ext = extForContentType(contentType) ?? fallbackExt;
  return cleaned.toLowerCase().endsWith(`.${ext}`) ? cleaned : `${cleaned}.${ext}`;
}

// Ensure a filename is unique within a set, suffixing "-2", "-3", … before the
// extension on collision. Mutates `used` (adds the returned name). Keeps zip
// entries from silently overwriting each other when two items share a name.
export function dedupeName(name: string, used: Set<string>): string {
  if (!used.has(name)) {
    used.add(name);
    return name;
  }
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  let n = 2;
  let candidate = `${stem}-${n}${ext}`;
  while (used.has(candidate)) {
    n += 1;
    candidate = `${stem}-${n}${ext}`;
  }
  used.add(candidate);
  return candidate;
}

// Above this total the stills set is streamed as sequential downloads instead
// of an in-memory zip. ~500 MB: in-memory zipSync holds both the fetched bytes
// and the output archive, so the peak is ~2× this — comfortable on desktop,
// and it puts the known ~595 MB / 103-image outlier onto the sequential path.
export const STILLS_ZIP_MAX_BYTES = 500 * 1024 * 1024;

export function shouldZipStillsInMemory(totalBytes: number): boolean {
  return totalBytes <= STILLS_ZIP_MAX_BYTES;
}
