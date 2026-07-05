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

// The single zip-vs-sequential threshold for BOTH clips and stills, both form
// factors. At or under this total the set is fetched and zipped into one
// archive; over it, sequential downloads. 512 MiB (536,870,912 bytes) — set
// deliberately just above the motivating Erupcja clips set (525,488,587 B /
// ~501 MB) so it zips to one file by design, not by luck.
//
// MEMORY: the in-memory zip path holds the fetched bytes AND the output archive
// AND (briefly) the Blob copy, so the transient peak is up to ~3× this total for
// already-compressed media (the hook frees the input buffers before the Blob to
// shave it toward ~2×). A near-cap set can still OOM a low-memory mobile tab —
// which is what shouldZipBundle's device-memory gate below guards against.
export const BUNDLE_ZIP_MAX_BYTES = 512 * 1024 * 1024;

// Size-only decision (pure, size-testable).
export function shouldZipInMemory(totalBytes: number): boolean {
  return totalBytes <= BUNDLE_ZIP_MAX_BYTES;
}

// Full branch decision: an iOS short-circuit, THEN the device-memory gate, THEN
// the size threshold.
//   - isIOS: every iOS browser is WebKit, with a low, uncatchable per-tab memory
//     ceiling AND no navigator.deviceMemory, so the in-memory zip OOM-kills the
//     tab on large sets (observed: Erupcja ~501 MB died at ~11/91 fetches, silent
//     tab reload). Force SEQUENTIAL regardless of size — this MUST come first,
//     ahead of the deviceMemory/size logic, because deviceMemory can't catch iOS.
//   - deviceMemory <= 4 GiB: low-memory device (the ~2-3× in-memory zip peak
//     risks an OOM tab crash) -> sequential regardless of size.
//   - deviceMemory absent on a NON-iOS browser (desktop Safari/Firefox, ample
//     RAM): the size threshold alone governs — graceful degradation, never a
//     hard block.
export function shouldZipBundle(
  totalBytes: number,
  deviceMemoryGiB: number | undefined,
  isIOS: boolean,
): boolean {
  if (isIOS) return false;
  if (typeof deviceMemoryGiB === "number" && deviceMemoryGiB <= 4) return false;
  return shouldZipInMemory(totalBytes);
}
