"use client";

import Link from "next/link";
import { useMemo, useRef, useState } from "react";

type Kind = "clip" | "still";
type Status = "pending" | "uploading" | "done" | "error";

type Item = {
  id: string;
  kind: Kind;
  file: File;
  label: string;
  status: Status;
  progress: number;
  error?: string;
};

type Props = {
  titleId: string;
  titleName: string;
  titleSlug: string;
};

function extOf(file: File): string {
  const m = file.name.match(/\.([a-zA-Z0-9]+)$/);
  return (m?.[1] ?? "").toLowerCase();
}

function defaultLabel(file: File): string {
  return file.name.replace(/\.[^.]+$/, "");
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

async function probeImageDims(
  file: File,
): Promise<{ width: number; height: number } | null> {
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

async function probeVideoDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement("video");
    v.preload = "metadata";
    v.onloadedmetadata = () => {
      URL.revokeObjectURL(url);
      resolve(Number.isFinite(v.duration) ? v.duration : null);
    };
    v.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    v.src = url;
  });
}

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

export default function UploadClient({ titleId, titleName, titleSlug }: Props) {
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const clipsInputRef = useRef<HTMLInputElement | null>(null);
  const stillsInputRef = useRef<HTMLInputElement | null>(null);

  const counts = useMemo(() => {
    const total = items.length;
    const uploaded = items.filter((i) => i.status === "done").length;
    const failed = items.filter((i) => i.status === "error").length;
    return { total, uploaded, failed };
  }, [items]);

  function addFiles(kind: Kind, files: FileList | null) {
    if (!files) return;
    const additions: Item[] = Array.from(files).map((f) => ({
      id: `${kind}-${f.name}-${f.size}-${Math.random().toString(36).slice(2, 8)}`,
      kind,
      file: f,
      label: defaultLabel(f),
      status: "pending" as Status,
      progress: 0,
    }));
    setItems((prev) => [...prev, ...additions]);
    setDone(false);
  }

  function setItem(id: string, patch: Partial<Item>) {
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, ...patch } : i)));
  }

  function removeItem(id: string) {
    setItems((prev) => prev.filter((i) => i.id !== id));
  }

  async function uploadOne(item: Item) {
    const ext = extOf(item.file);
    if (!ext) {
      setItem(item.id, { status: "error", error: "no extension" });
      return;
    }

    const index = Date.now() + Math.floor(Math.random() * 1000);
    setItem(item.id, { status: "uploading", progress: 0 });

    try {
      const labelTrimmed = item.label.trim();
      const baseName = labelTrimmed || item.file.name.replace(/\.[^.]+$/, "");
      const downloadFilename = baseName.toLowerCase().endsWith(`.${ext}`)
        ? baseName
        : `${baseName}.${ext}`;

      const presignParams = new URLSearchParams({
        type: item.kind,
        ext,
        titleSlug,
        index: String(index),
        contentType: item.file.type || "",
        filename: downloadFilename,
      });
      const presignRes = await fetch(
        `/api/admin/r2/presign?${presignParams.toString()}`,
      );
      if (!presignRes.ok) {
        throw new Error(`presign ${presignRes.status}`);
      }
      const { url, key, contentType, contentDisposition } =
        (await presignRes.json()) as {
          url: string;
          key: string;
          contentType: string;
          contentDisposition: string;
        };

      await putWithProgress(
        url,
        item.file,
        contentType,
        contentDisposition,
        (pct) => {
          setItem(item.id, { progress: pct });
        },
      );

      let dims: { width: number; height: number } | null = null;
      let duration: number | null = null;
      if (item.kind === "still") {
        dims = await probeImageDims(item.file);
      } else {
        duration = await probeVideoDuration(item.file);
      }

      const metaEndpoint =
        item.kind === "clip" ? "/api/admin/clips" : "/api/admin/stills";
      const metaBody =
        item.kind === "clip"
          ? {
              title_id: titleId,
              key,
              label: item.label,
              content_type: contentType,
              file_size_bytes: item.file.size,
              duration_seconds: duration,
            }
          : {
              title_id: titleId,
              key,
              alt_text: item.label,
              content_type: contentType,
              file_size_bytes: item.file.size,
              width: dims?.width ?? null,
              height: dims?.height ?? null,
            };

      const metaRes = await fetch(metaEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(metaBody),
      });
      if (!metaRes.ok) {
        const t = await metaRes.text();
        throw new Error(`metadata ${metaRes.status}: ${t.slice(0, 200)}`);
      }

      setItem(item.id, { status: "done", progress: 100 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setItem(item.id, { status: "error", error: msg });
    }
  }

  async function uploadAll() {
    setBusy(true);
    setDone(false);
    const pending = items.filter(
      (i) => i.status === "pending" || i.status === "error",
    );
    for (const item of pending) {
      await uploadOne(item);
    }
    setBusy(false);
    setDone(true);
  }

  return (
    <div className="min-h-screen px-6 py-12 bg-[radial-gradient(ellipse_at_center,_#011754_0%,_#121212_100%)]">
      <div className="max-w-4xl mx-auto flex flex-col gap-8">
        <div className="flex flex-col gap-2">
          <p className="text-body-sm text-moonbeem-ink-subtle uppercase tracking-wider">
            Admin upload
          </p>
          <h1 className="font-wordmark font-bold text-display-md text-moonbeem-pink m-0">
            {titleName}
          </h1>
          <p className="text-body-sm text-moonbeem-ink-muted">
            slug: {titleSlug} · title_id: {titleId}
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <button
            type="button"
            onClick={() => clipsInputRef.current?.click()}
            className="bg-moonbeem-pink text-moonbeem-navy rounded-md px-4 py-3 text-body font-semibold hover:opacity-90 transition-opacity"
          >
            + Add clips (video)
          </button>
          <input
            ref={clipsInputRef}
            type="file"
            accept="video/*"
            multiple
            className="hidden"
            onChange={(e) => {
              addFiles("clip", e.target.files);
              e.target.value = "";
            }}
          />
          <button
            type="button"
            onClick={() => stillsInputRef.current?.click()}
            className="bg-transparent border border-moonbeem-pink text-moonbeem-pink rounded-md px-4 py-3 text-body font-semibold hover:bg-moonbeem-pink hover:text-moonbeem-navy transition-colors"
          >
            + Add stills (image)
          </button>
          <input
            ref={stillsInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => {
              addFiles("still", e.target.files);
              e.target.value = "";
            }}
          />
        </div>

        {items.length > 0 && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3">
              <p className="text-body-sm text-moonbeem-ink-muted">
                {counts.uploaded} of {counts.total} uploaded
                {counts.failed > 0 && ` · ${counts.failed} failed`}
              </p>
              <button
                type="button"
                disabled={busy || items.every((i) => i.status === "done")}
                onClick={uploadAll}
                className="bg-moonbeem-pink text-moonbeem-navy rounded-md px-4 py-2 text-body-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed hover:opacity-90 transition-opacity"
              >
                {busy ? "Uploading..." : "Upload all"}
              </button>
            </div>

            <ul className="flex flex-col gap-2">
              {items.map((it) => (
                <li
                  key={it.id}
                  className="flex flex-col gap-1 border border-moonbeem-border rounded-md p-3 bg-black/30"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-body-sm text-moonbeem-ink-subtle uppercase tracking-wider shrink-0">
                        {it.kind}
                      </span>
                      <span className="text-body-sm text-moonbeem-ink truncate">
                        {it.file.name}
                      </span>
                      <span className="text-body-sm text-moonbeem-ink-subtle shrink-0">
                        {formatBytes(it.file.size)}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <span className="text-body-sm text-moonbeem-ink-muted">
                        {it.status === "uploading" && `${it.progress}%`}
                        {it.status === "done" && "done"}
                        {it.status === "error" && "error"}
                        {it.status === "pending" && "pending"}
                      </span>
                      {it.status === "pending" && (
                        <button
                          type="button"
                          onClick={() => removeItem(it.id)}
                          className="text-body-sm text-moonbeem-ink-subtle hover:text-moonbeem-pink"
                        >
                          remove
                        </button>
                      )}
                    </div>
                  </div>
                  <input
                    type="text"
                    value={it.label}
                    onChange={(e) =>
                      setItem(it.id, { label: e.target.value })
                    }
                    disabled={it.status === "uploading" || it.status === "done"}
                    placeholder={
                      it.kind === "clip" ? "Label" : "Alt text / caption"
                    }
                    className="w-full bg-transparent border border-moonbeem-border rounded px-2 py-1 text-body-sm text-moonbeem-ink placeholder:text-moonbeem-ink-subtle focus:outline-none focus:border-moonbeem-pink disabled:opacity-60"
                  />
                  {it.status === "uploading" && (
                    <div className="h-1 w-full bg-moonbeem-border rounded overflow-hidden">
                      <div
                        className="h-full bg-moonbeem-pink transition-[width]"
                        style={{ width: `${it.progress}%` }}
                      />
                    </div>
                  )}
                  {it.status === "error" && it.error && (
                    <p className="text-body-sm text-moonbeem-magenta">
                      {it.error}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {done && (
          <Link
            href={`/t/${titleSlug}`}
            className="text-body text-moonbeem-pink hover:opacity-80 transition-opacity"
          >
            View on {titleName} page →
          </Link>
        )}
      </div>
    </div>
  );
}
