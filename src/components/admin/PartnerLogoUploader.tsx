"use client";

import { useEffect, useState } from "react";

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

// Spec (2026-05-12): PNG and SVG only. Strict 16:9 with ±2%
// tolerance to absorb rounding. Min 1280×720 so the asset stays
// crisp on retina at marquee display heights. 2 MB cap unchanged.
// Server-side dimension/aspect validation is architecturally
// impossible with the presigned-PUT flow (browser uploads bytes
// directly to R2; server never sees them). Post-upload byte
// verification is queued as a post-pitch followup that pairs with
// the super-admin partner activation UI work.
const ACCEPTED_EXTS = ["png", "svg"] as const;
const EXT_TO_MIME: Record<(typeof ACCEPTED_EXTS)[number], string> = {
  png: "image/png",
  svg: "image/svg+xml",
};
const ACCEPTED_MIME = Object.values(EXT_TO_MIME);
const MAX_BYTES = 2 * 1024 * 1024;
const MIN_WIDTH = 1280;
const MIN_HEIGHT = 720;
const ASPECT_TARGET = 16 / 9;
const ASPECT_TOLERANCE = 0.02;

function extOf(file: File): string {
  const m = file.name.match(/\.([a-zA-Z0-9]+)$/);
  return (m?.[1] ?? "").toLowerCase();
}

// SVG dimension extraction. Prefer viewBox ("0 0 W H") since it
// describes intrinsic aspect regardless of how the SVG is sized
// downstream; fall back to numeric width/height attributes on the
// root <svg> when viewBox is absent. Returns null when neither is
// usable — caller treats that as a hard fail so we never write an
// un-validatable SVG to R2.
function parseSvgDimensions(
  text: string,
): { width: number; height: number } | null {
  const svgMatch = text.match(/<svg\b[^>]*>/i);
  if (!svgMatch) return null;
  const svgTag = svgMatch[0];

  // viewBox can be "min-x min-y width height", whitespace or comma sep.
  const vb = svgTag.match(/\bviewBox\s*=\s*["']([^"']+)["']/i);
  if (vb) {
    const parts = vb[1].trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts.every((n) => Number.isFinite(n))) {
      const [, , w, h] = parts;
      if (w > 0 && h > 0) return { width: w, height: h };
    }
  }

  // Fall back to width/height attributes. Strip "px" / "pt" etc.
  const wAttr = svgTag.match(/\bwidth\s*=\s*["']([^"']+)["']/i);
  const hAttr = svgTag.match(/\bheight\s*=\s*["']([^"']+)["']/i);
  const wNum = wAttr ? parseFloat(wAttr[1]) : NaN;
  const hNum = hAttr ? parseFloat(hAttr[1]) : NaN;
  if (Number.isFinite(wNum) && Number.isFinite(hNum) && wNum > 0 && hNum > 0) {
    return { width: wNum, height: hNum };
  }

  return null;
}

async function probeImage(
  file: File,
): Promise<{ width: number; height: number } | null> {
  if (file.type === "image/svg+xml") {
    const text = await file.text();
    return parseSvgDimensions(text);
  }
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

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024).toFixed(0)} KB`;
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

  // Revoke any blob: ObjectURL when currentUrl changes or this
  // component unmounts. The cleanup closes over the PREVIOUS
  // currentUrl, so each replace correctly revokes the prior blob.
  // R2 URLs (https://) are skipped — only blob: URLs need revoking.
  useEffect(() => {
    return () => {
      if (currentUrl && currentUrl.startsWith("blob:")) {
        URL.revokeObjectURL(currentUrl);
      }
    };
  }, [currentUrl]);

  async function onPick(file: File) {
    if (busy) return;
    setError(null);
    const ext = extOf(file);
    const mime = file.type;
    const extOk = (ACCEPTED_EXTS as readonly string[]).includes(ext);
    const mimeOk = (ACCEPTED_MIME as readonly string[]).includes(mime);
    // Both ext and MIME must be in the accepted set. Catches the
    // common "drag in a JPEG" case before we probe bytes.
    if (!extOk || !mimeOk) {
      const detected = mime || `.${ext || "(unknown)"}`;
      setError(`File must be PNG or SVG. Your file is ${detected}.`);
      return;
    }
    // Both are accepted formats — but they must agree, or the file
    // is renamed (e.g. JPEG → .png). Renames cause downstream
    // Content-Type vs bytes mismatches on R2 (see the 2026-05-11
    // HEIC regression for the same shape of bug). Reject explicitly.
    if (mime !== EXT_TO_MIME[ext as (typeof ACCEPTED_EXTS)[number]]) {
      setError(
        `File extension and content don't match. File appears to be ${mime} but is named .${ext}.`,
      );
      return;
    }
    if (file.size > MAX_BYTES) {
      setError(
        `File must be under 2 MB. Your file is ${formatBytes(file.size)}.`,
      );
      return;
    }
    const dims = await probeImage(file);
    if (!dims) {
      // SVGs without viewBox or width/height land here. PNGs that
      // fail to decode also land here, but that's a degenerate file.
      setError(
        file.type === "image/svg+xml"
          ? "SVG must declare a viewBox or width/height on the root <svg>. Re-export with viewBox set."
          : "Could not read image. Try a different file.",
      );
      return;
    }
    // 16:9 aspect ratio (±2% tolerance to absorb rounding).
    const actualAspect = dims.width / dims.height;
    if (Math.abs(actualAspect - ASPECT_TARGET) / ASPECT_TARGET > ASPECT_TOLERANCE) {
      const ratioFmt = `${actualAspect.toFixed(2)}:1`;
      setError(
        `Image must be 16:9 aspect ratio. Your image is ${ratioFmt} (${dims.width}×${dims.height}).`,
      );
      return;
    }
    // Min dimensions — only meaningful for raster. SVG viewBox
    // dimensions are unitless and the asset is vector-scalable, so
    // the min-dimension check is skipped for SVG (a viewBox of
    // 0 0 16 9 still represents a true 16:9 vector that renders
    // crisp at any size).
    if (
      file.type !== "image/svg+xml" &&
      (dims.width < MIN_WIDTH || dims.height < MIN_HEIGHT)
    ) {
      setError(
        `Image must be at least ${MIN_WIDTH}×${MIN_HEIGHT}. Your image is ${dims.width}×${dims.height}.`,
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
        {/* 16:9 preview tile (64×114) — matches the spec'd asset
            aspect, so the modal preview reflects how the logo will
            actually render in downstream surfaces (partner page
            header, future marquee). 2026-05-12 follow-up to the
            same-day aspect-ratio enforcement. */}
        <div className="relative h-16 w-[7.11rem] shrink-0 overflow-hidden rounded-md border border-white/10 bg-black/30">
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
            PNG or SVG · 16:9 · ≥ {MIN_WIDTH}×{MIN_HEIGHT} · ≤ 2&nbsp;MB
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

