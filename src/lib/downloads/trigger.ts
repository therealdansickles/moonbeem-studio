// Browser download triggers for the "download all" bundle feature. Plain
// functions (no React) imported only by the "use client" tab components and
// invoked inside event handlers, so the `document` references never run during
// SSR.

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
