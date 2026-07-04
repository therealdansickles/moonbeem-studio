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
//   2. shouldZipInMemory — the size guard for the zip-vs-sequential branch,
//      shared by BOTH clips and stills. At or under the cap the browser fetches
//      the set and fflate-zips it into one archive; over it we fall back to
//      sequential downloads so a large set (e.g. a multi-hundred-MB clips set,
//      or the 103-image / ~595 MB stills outlier) can't OOM the tab.

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

// The single zip-vs-sequential threshold for BOTH clips and stills. At or under
// this total the set is fetched and zipped into one archive; over it, sequential
// downloads. ~500 MiB (524,288,000 bytes). MEMORY: the in-memory zip path holds
// the fetched bytes AND the output archive AND (briefly) the Blob copy of that
// archive, so the transient peak is up to ~3× this total for already-compressed
// media (the hook drops the input buffers before the Blob to shave it toward
// ~2×). Fine on desktop; a near-cap set can still OOM a mobile tab. One knob.
//
// TUNING NOTES (open, per Dan's re-review): (a) the motivating Erupcja clips set
// is 525,488,587 B (~501 MB) — ~1.14 MB OVER this cap, so it sequences; raising
// the cap to 512 MiB (536,870,912) would zip it. (b) Mobile multi-download
// behavior + tighter memory may argue for a LOWER mobile cap (or a streaming/
// worker zip) than desktop — the shared hook is the one place to change it.
export const BUNDLE_ZIP_MAX_BYTES = 500 * 1024 * 1024;

export function shouldZipInMemory(totalBytes: number): boolean {
  return totalBytes <= BUNDLE_ZIP_MAX_BYTES;
}
