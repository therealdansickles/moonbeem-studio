"use client";

import { useRef, useState } from "react";
import AvatarCircle from "./AvatarCircle";

type Props = {
  handle: string;
  displayName: string | null;
  currentUrl: string | null;
  onUploaded: (publicUrl: string) => void;
};

const ALLOWED_EXTS = new Set(["jpg", "jpeg", "png", "webp"]);

function extOf(file: File): string {
  const m = file.name.match(/\.([a-zA-Z0-9]+)$/);
  return (m?.[1] ?? "").toLowerCase();
}

export default function AvatarUploader({
  handle,
  displayName,
  currentUrl,
  onUploaded,
}: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [preview, setPreview] = useState<string | null>(currentUrl);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function onChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    setError("");
    let ext = extOf(file);
    if (!ALLOWED_EXTS.has(ext)) {
      // Map content type when extension missing/unusual.
      if (file.type === "image/png") ext = "png";
      else if (file.type === "image/webp") ext = "webp";
      else if (file.type === "image/jpeg") ext = "jpg";
      else {
        setError("Use a JPG, PNG, or WEBP image.");
        return;
      }
    }

    setBusy(true);
    try {
      const presignRes = await fetch(
        `/api/profile/avatar/presign?ext=${encodeURIComponent(ext)}`,
      );
      if (!presignRes.ok) throw new Error(`presign ${presignRes.status}`);
      const { url, contentType, contentDisposition, public_url } =
        (await presignRes.json()) as {
          url: string;
          key: string;
          contentType: string;
          contentDisposition: string;
          public_url: string;
        };

      const putRes = await fetch(url, {
        method: "PUT",
        headers: {
          "Content-Type": contentType,
          "Content-Disposition": contentDisposition,
        },
        body: file,
      });
      if (!putRes.ok) {
        throw new Error(`R2 PUT ${putRes.status}`);
      }

      // Cache-bust so the freshly uploaded URL doesn't show a stale image
      // on browsers that have cached the same path.
      const cacheBusted = `${public_url}?v=${Date.now()}`;
      setPreview(cacheBusted);
      onUploaded(cacheBusted);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-4">
      <AvatarCircle
        avatarUrl={preview}
        displayName={displayName}
        handle={handle}
        size={80}
      />
      <div className="flex flex-col gap-1">
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={busy}
          className="rounded-md border border-white/15 bg-white/5 px-3 py-1.5 text-body-sm text-moonbeem-ink transition-colors hover:border-moonbeem-pink hover:text-moonbeem-pink disabled:opacity-50"
        >
          {busy ? "Uploading..." : preview ? "Change avatar" : "Upload avatar"}
        </button>
        <p className="text-caption text-moonbeem-ink-subtle">
          JPG, PNG, or WEBP. Cropped to a circle.
        </p>
        {error && <p className="text-caption text-moonbeem-magenta">{error}</p>}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        onChange={onChange}
      />
    </div>
  );
}
