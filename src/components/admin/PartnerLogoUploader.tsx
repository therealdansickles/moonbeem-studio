"use client";

import { useState } from "react";

type Props = {
  // Slug must be set before the user can upload — drives the R2
  // path. The Edit modal always has a slug; the AttachTitleModal's
  // create-new flow disables the uploader until the user types one.
  partnerSlug: string;
  initialUrl?: string | null;
  // Called on successful upload with the R2 object key (not the
  // full public URL — R2_PUBLIC_URL is server-only). Parent should
  // pass `logo_key` to the partner API; the server resolves it to
  // logo_url via buildPublicUrl. We also pass back the previewable
  // URL so the parent can render an immediate confirmation.
  onUploaded: (args: { key: string; previewUrl: string }) => void;
  // Optional: parent can render a "remove" button that clears the
  // logo_url back to null. We don't delete the R2 object (matches
  // the clips/stills retention pattern; purge is a separate job).
  onCleared?: () => void;
};

const ACCEPTED_EXTS = ["png", "jpg", "jpeg", "webp", "svg"] as const;
const ACCEPTED_MIME = ACCEPTED_EXTS.map((e) => {
  if (e === "png") return "image/png";
  if (e === "webp") return "image/webp";
  if (e === "svg") return "image/svg+xml";
  return "image/jpeg";
});
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_DIMENSION = 1024;

function extOf(file: File): string {
  const m = file.name.match(/\.([a-zA-Z0-9]+)$/);
  return (m?.[1] ?? "").toLowerCase();
}

async function probeImage(
  file: File,
): Promise<{ width: number; height: number } | null> {
  // SVGs are vector; skip dimension probe.
  if (file.type === "image/svg+xml") return { width: 0, height: 0 };
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new window.Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    img.src = url;
  });
}

async function putWithProgress(
  url: string,
  file: File,
  contentType: string,
  contentDisposition: string,
  onProgress: (pct: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url, true);
    xhr.setRequestHeader("Content-Type", contentType);
    xhr.setRequestHeader("Content-Disposition", contentDisposition);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`R2 PUT failed: ${xhr.status} ${xhr.statusText}`));
    };
    xhr.onerror = () => reject(new Error("R2 PUT network error"));
    xhr.send(file);
  });
}

export default function PartnerLogoUploader({
  partnerSlug,
  initialUrl,
  onUploaded,
  onCleared,
}: Props) {
  const [currentUrl, setCurrentUrl] = useState<string | null>(
    initialUrl ?? null,
  );
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const slugReady = !!partnerSlug && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(
    partnerSlug,
  );

  async function onPick(file: File) {
    if (busy) return;
    setError(null);
    const ext = extOf(file);
    if (!(ACCEPTED_EXTS as readonly string[]).includes(ext)) {
      setError(`Unsupported format. Use: ${ACCEPTED_EXTS.join(", ")}.`);
      return;
    }
    if (file.size > MAX_BYTES) {
      setError(`Logo must be ≤ 2 MB (got ${(file.size / 1024 / 1024).toFixed(1)} MB).`);
      return;
    }
    const dims = await probeImage(file);
    if (!dims) {
      setError("Could not read image. Try a different file.");
      return;
    }
    if (
      file.type !== "image/svg+xml" &&
      (dims.width > MAX_DIMENSION || dims.height > MAX_DIMENSION)
    ) {
      setError(
        `Logo dimensions must be ≤ ${MAX_DIMENSION}×${MAX_DIMENSION} (got ${dims.width}×${dims.height}).`,
      );
      return;
    }

    setBusy(true);
    setProgress(0);
    try {
      const presignParams = new URLSearchParams({
        type: "partner-logo",
        ext,
        partnerSlug,
        contentType: file.type || "application/octet-stream",
        filename: file.name,
      });
      const presignRes = await fetch(
        `/api/admin/r2/presign?${presignParams.toString()}`,
      );
      const presignJson = (await presignRes.json()) as {
        url?: string;
        key?: string;
        contentType?: string;
        contentDisposition?: string;
        error?: string;
      };
      if (!presignRes.ok || !presignJson.url || !presignJson.key) {
        setError(presignJson.error ?? `presign failed (${presignRes.status})`);
        return;
      }

      await putWithProgress(
        presignJson.url,
        file,
        presignJson.contentType ?? file.type,
        presignJson.contentDisposition ?? "",
        setProgress,
      );

      // Show the freshly-uploaded file inline using the local
      // ObjectURL we already have via createObjectURL — no need to
      // round-trip the public URL back from the server. Parent
      // receives the R2 key and PATCHes the partner; once the
      // server resolves logo_url, subsequent renders use it.
      const localPreview = URL.createObjectURL(file);
      setCurrentUrl(localPreview);
      onUploaded({ key: presignJson.key, previewUrl: localPreview });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setProgress(0);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-4">
        <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-md border border-white/10 bg-black/30">
          {currentUrl ? (
            // Plain <img>: avoids the next/image domain whitelist
            // requirement for arbitrary R2 public URLs in admin
            // surfaces. We're rendering small, no LCP concern.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={currentUrl}
              alt="Partner logo"
              className="h-full w-full object-contain"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-caption text-moonbeem-ink-subtle">
              none
            </div>
          )}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <label
            className={`inline-flex w-fit items-center gap-2 rounded-md border border-white/15 bg-white/5 px-3 py-1.5 text-body-sm text-moonbeem-ink ${
              busy || !slugReady
                ? "cursor-not-allowed opacity-50"
                : "cursor-pointer hover:border-moonbeem-pink hover:text-moonbeem-pink"
            }`}
          >
            <input
              type="file"
              accept={ACCEPTED_MIME.join(",")}
              disabled={busy || !slugReady}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void onPick(f);
                // Reset input so same-file reselect works.
                e.target.value = "";
              }}
              className="sr-only"
            />
            {busy
              ? `Uploading… ${progress}%`
              : currentUrl
                ? "Replace logo"
                : "Upload logo"}
          </label>
          <span className="text-caption text-moonbeem-ink-subtle">
            PNG, JPG, WEBP, or SVG · ≤ 2&nbsp;MB · ≤ {MAX_DIMENSION}×{MAX_DIMENSION}
          </span>
          {!slugReady && (
            <span className="text-caption text-moonbeem-ink-subtle">
              Type a slug above before uploading.
            </span>
          )}
          {currentUrl && onCleared && (
            <button
              type="button"
              onClick={() => {
                setCurrentUrl(null);
                onCleared();
              }}
              className="w-fit text-caption text-moonbeem-ink-muted hover:text-moonbeem-magenta"
            >
              Remove logo
            </button>
          )}
        </div>
      </div>
      {error && (
        <p className="text-caption text-moonbeem-magenta">{error}</p>
      )}
    </div>
  );
}

