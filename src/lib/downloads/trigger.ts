// Browser download triggers for the download feature. Plain functions (no React)
// imported only by the "use client" tab components and invoked inside event
// handlers, so the `document`/`navigator` references never run during SSR.

import { chooseSavePath } from "./bundle";

// Trigger a browser download of a URL. For the cross-origin R2 objects the
// `download` attribute's filename is ignored and R2's Content-Disposition
// (attachment + original filename) takes over — so each object streams straight
// R2 → disk with its real name, no bytes through our server. For a blob: URL
// the download name IS honored.
export function triggerAnchorDownload(url: string, filename: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function triggerBlobDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  triggerAnchorDownload(url, filename);
  // Defer revocation so the browser has grabbed the blob before we release it —
  // immediate revoke can cancel a large save (e.g. a multi-hundred-MB zip).
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// iOS per-item save: hand the file to the native share sheet where the browser
// supports it (Save to Files / AirDrop / Messages), else fall back to a single
// anchor download. Call this ONLY on iOS — non-iOS keeps its own anchor path
// unchanged. (chooseSavePath is passed isIOS=true here because the caller has
// already established we're on iOS.)
export async function saveBlobToDevice(
  blob: Blob,
  filename: string,
): Promise<void> {
  const file = new File([blob], filename, {
    type: blob.type || "application/octet-stream",
  });
  const canShareFiles =
    typeof navigator !== "undefined" &&
    typeof navigator.canShare === "function" &&
    navigator.canShare({ files: [file] });
  if (chooseSavePath(true, canShareFiles) === "share") {
    try {
      await navigator.share({ files: [file] });
      return;
    } catch (err) {
      // User dismissed the sheet -> done, don't double-save. Any other failure
      // (e.g. lost user activation) -> fall through to the anchor download.
      if ((err as { name?: string })?.name === "AbortError") return;
    }
  }
  triggerBlobDownload(blob, filename);
}
