"use client";

// Shared poster editor — upload a file OR paste a URL. Both write poster_url
// through the SAME authorized PATCH /api/titles/[id]/poster (super-admin OR
// owning-partner-admin gate). Upload path: GET .../poster/presign
// (authorizeTitleMutation) → browser PUTs the file straight to R2 → PATCH
// { poster_key } → the server resolves the durable R2 public URL. Paste path:
// PATCH { poster_url } (http(s) validated client-side AND server-side). Shows
// the CURRENT poster (broken → "⚠ failed to load"). poster_url is the single
// column every display surface reads (title page + cards).
//
// This renders ONLY the editor body (preview + controls) — the consumer owns
// the card chrome + header (admin: <h2>Poster</h2>; partner: violet pill
// badge), so neither header is hardcoded here. Extracted from the admin
// TitleDetailTabs so the partner per-title page reuses the exact same
// upload→PUT→PATCH mechanism. titleSlug is intentionally NOT a prop: the routes
// key off titleId (presign resolves the slug server-side), and the /t/{slug}
// caption lives in the consumer's header.

import { useState } from "react";

function isValidHttpUrl(s: string): boolean {
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return false;
  }
  return u.protocol === "http:" || u.protocol === "https:";
}

// Poster file upload: jpeg/png/webp only (svg/avif excluded server-side too),
// 5 MB client-side cap (the file PUTs direct to R2 — the server never sees the
// bytes, so size is enforced here, mirroring the partner-logo pre-PUT check).
const POSTER_EXT_TO_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};
const POSTER_ACCEPT = "image/jpeg,image/png,image/webp";
const MAX_POSTER_BYTES = 5 * 1024 * 1024;

function posterExtOf(file: File): string {
  const m = file.name.match(/\.([a-zA-Z0-9]+)$/);
  return (m?.[1] ?? "").toLowerCase();
}

// XHR PUT with progress — the presigned-direct upload (mirrors
// PartnerLogoUploader). The browser PUTs the file straight to R2.
function putWithProgress(
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

export default function PosterEditor({
  titleId,
  initialPosterUrl,
  onSaved,
}: {
  titleId: string;
  initialPosterUrl: string | null;
  // Optional: notified with the new poster_url after a successful save (file or
  // URL). The PATCH route already revalidates /t/[slug] server-side, so this is
  // only for consumers that want to react (e.g. a server-component refresh).
  onSaved?: (posterUrl: string) => void;
}) {
  const [saved, setSaved] = useState<string | null>(initialPosterUrl);
  const [value, setValue] = useState(initialPosterUrl ?? "");
  const [state, setState] = useState<"idle" | "saving" | "error" | "saved">(
    "idle",
  );
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [imgFailed, setImgFailed] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);

  const trimmed = value.trim();
  const dirty = trimmed !== (saved ?? "");
  const malformed = trimmed.length > 0 && !isValidHttpUrl(trimmed);
  const canSave =
    dirty && isValidHttpUrl(trimmed) && state !== "saving" && !uploading;

  async function onPickFile(file: File) {
    if (uploading || state === "saving") return;
    setErrorMsg(null);
    setState("idle");

    // Client-side validation (the server can't size-check a direct-to-R2 PUT).
    const ext = posterExtOf(file);
    const mime = file.type;
    const expected = POSTER_EXT_TO_MIME[ext];
    if (!expected || !POSTER_ACCEPT.split(",").includes(mime)) {
      setState("error");
      setErrorMsg("Poster must be a JPG, PNG, or WebP image.");
      return;
    }
    if (mime !== expected) {
      setState("error");
      setErrorMsg(
        `File extension and content don't match (named .${ext} but is ${mime}).`,
      );
      return;
    }
    if (file.size > MAX_POSTER_BYTES) {
      setState("error");
      setErrorMsg(
        `Image must be under 5 MB. Yours is ${(file.size / 1024 / 1024).toFixed(1)} MB.`,
      );
      return;
    }

    setUploading(true);
    setProgress(0);
    try {
      const presignRes = await fetch(
        `/api/titles/${titleId}/poster/presign?ext=${encodeURIComponent(ext)}`,
      );
      const presign = (await presignRes.json().catch(() => ({}))) as {
        url?: string;
        key?: string;
        contentType?: string;
        contentDisposition?: string;
        error?: string;
      };
      if (!presignRes.ok || !presign.url || !presign.key) {
        setState("error");
        setErrorMsg(presign.error ?? `presign failed (${presignRes.status})`);
        return;
      }

      await putWithProgress(
        presign.url,
        file,
        presign.contentType ?? mime,
        presign.contentDisposition ?? "",
        setProgress,
      );

      // Write-back: resolve the R2 key → poster_url via the same authorized
      // PATCH (R2 is read-after-write consistent, so the public URL renders).
      const patchRes = await fetch(`/api/titles/${titleId}/poster`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ poster_key: presign.key }),
      });
      const patch = (await patchRes.json().catch(() => ({}))) as {
        ok?: boolean;
        poster_url?: string;
        error?: string;
      };
      if (!patchRes.ok || !patch.ok || !patch.poster_url) {
        setState("error");
        setErrorMsg(patch.error ?? `save failed (${patchRes.status})`);
        return;
      }
      setSaved(patch.poster_url);
      setValue(patch.poster_url);
      setImgFailed(false);
      setState("saved");
      onSaved?.(patch.poster_url);
    } catch (err) {
      setState("error");
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
      setProgress(0);
    }
  }

  async function save() {
    if (!canSave) return;
    setState("saving");
    setErrorMsg(null);
    try {
      const res = await fetch(`/api/titles/${titleId}/poster`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ poster_url: trimmed }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        poster_url?: string;
        error?: string;
      };
      if (!res.ok || !json.ok || !json.poster_url) {
        setState("error");
        setErrorMsg(json.error ?? `request failed (${res.status})`);
        return;
      }
      setSaved(json.poster_url);
      setValue(json.poster_url);
      setImgFailed(false);
      setState("saved");
      onSaved?.(json.poster_url);
    } catch (err) {
      setState("error");
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="mt-5 flex flex-col gap-4 sm:flex-row sm:items-start">
      <div className="relative aspect-[2/3] w-[120px] shrink-0 overflow-hidden rounded-lg border border-white/10 bg-moonbeem-navy/40">
        {saved && !imgFailed ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={saved}
            alt="Current poster"
            className="h-full w-full object-cover"
            onError={() => setImgFailed(true)}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center p-2 text-center text-caption text-moonbeem-ink-subtle">
            {saved ? "⚠ failed to load" : "no poster"}
          </div>
        )}
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-3">
        {/* Upload a file (primary — durable R2). */}
        <div className="flex flex-col gap-1">
          <label
            className={`inline-flex w-fit items-center gap-2 rounded-md border border-white/15 bg-white/5 px-3 py-1.5 text-body-sm text-moonbeem-ink ${
              uploading || state === "saving"
                ? "cursor-not-allowed opacity-50"
                : "cursor-pointer hover:border-moonbeem-pink hover:text-moonbeem-pink"
            }`}
          >
            <input
              type="file"
              accept={POSTER_ACCEPT}
              disabled={uploading || state === "saving"}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void onPickFile(f);
                e.target.value = ""; // allow same-file reselect
              }}
              className="sr-only"
            />
            {uploading ? `Uploading… ${progress}%` : "Upload a file"}
          </label>
          <span className="text-caption text-moonbeem-ink-subtle">
            JPG, PNG, or WebP · ≤ 5&nbsp;MB
          </span>
        </div>

        {/* OR paste a URL. */}
        <div className="flex items-center gap-3">
          <span className="h-px flex-1 bg-white/10" />
          <span className="text-caption text-moonbeem-ink-subtle">
            or paste a URL
          </span>
          <span className="h-px flex-1 bg-white/10" />
        </div>

        <input
          type="url"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            if (state !== "idle") setState("idle");
          }}
          placeholder="https://…"
          disabled={uploading}
          className="w-full rounded-md border border-white/10 bg-black/30 px-3 py-2 text-body-sm text-moonbeem-ink focus:border-moonbeem-pink focus:outline-none disabled:opacity-50"
        />
        {malformed && (
          <p className="m-0 text-caption text-moonbeem-magenta">
            Enter a valid http(s) URL.
          </p>
        )}
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={save}
            disabled={!canSave}
            className="rounded-md bg-moonbeem-pink px-4 py-2 text-body-sm font-semibold text-moonbeem-navy transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {state === "saving" ? "Saving…" : "Save poster"}
          </button>
          {state === "saved" && !dirty && (
            <span className="text-caption text-emerald-300">Saved ✓</span>
          )}
        </div>
        {errorMsg && (
          <p className="m-0 text-caption text-moonbeem-magenta">{errorMsg}</p>
        )}
      </div>
    </div>
  );
}
