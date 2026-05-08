"use client";

import { useState } from "react";

type ImportError = {
  row: number;
  embed_url: string | null;
  reason: string;
};

type ImportResult = {
  imported: number;
  skipped_duplicates: number;
  skipped_invalid: number;
  errors: ImportError[];
};

type Status = "idle" | "uploading" | "done" | "error";

type Props = {
  // When set, the importer scopes every CSV row to this title_id and
  // the title_id column becomes optional. Used by the per-title page
  // at /admin/titles/[slug]?tab=upload where the context is explicit.
  titleIdOverride?: string;
};

export default function FanEditsUploadCard({ titleIdOverride }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [result, setResult] = useState<ImportResult | null>(null);
  const [errorMsg, setErrorMsg] = useState<string>("");

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!file || status === "uploading") return;
    setStatus("uploading");
    setResult(null);
    setErrorMsg("");
    const fd = new FormData();
    fd.append("file", file);
    if (titleIdOverride) fd.append("title_id_override", titleIdOverride);
    try {
      const res = await fetch("/api/admin/fan-edits/import", {
        method: "POST",
        body: fd,
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text.slice(0, 500) || `import ${res.status}`);
      }
      const data = (await res.json()) as ImportResult;
      setResult(data);
      setStatus("done");
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setStatus("error");
    }
  }

  const requiredCols = titleIdOverride
    ? "embed_url, platform, creator_handle"
    : "embed_url, platform, creator_handle, title_id";

  return (
    <div className="flex flex-col gap-6">
      <p className="text-body-sm text-moonbeem-ink-muted">
        Upload a CSV. Required columns:{" "}
        <code className="font-mono text-moonbeem-ink">{requiredCols}</code>.
        Recommended: <code className="font-mono">caption, posted_at, thumbnail_url</code>.
        {titleIdOverride && (
          <>
            {" "}
            <span className="text-moonbeem-ink-subtle">
              title_id is auto-filled from the page context — omit it from
              the CSV or it will be ignored.
            </span>
          </>
        )}
      </p>

      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <input
          type="file"
          accept=".csv,text/csv"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          disabled={status === "uploading"}
          className="text-body-sm text-moonbeem-ink file:mr-4 file:rounded-md file:border file:border-moonbeem-border-strong file:bg-white/5 file:px-4 file:py-2 file:text-body-sm file:text-moonbeem-ink hover:file:border-moonbeem-pink hover:file:text-moonbeem-pink file:transition-colors"
        />
        <button
          type="submit"
          disabled={!file || status === "uploading"}
          className="self-start rounded-md bg-moonbeem-pink text-moonbeem-navy px-5 py-2 text-body font-semibold hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity"
        >
          {status === "uploading" ? "Importing…" : "Import"}
        </button>
      </form>

      {status === "error" && (
        <div className="rounded-md border border-moonbeem-magenta bg-moonbeem-magenta/10 px-4 py-3">
          <p className="text-body-sm text-moonbeem-magenta">{errorMsg}</p>
        </div>
      )}

      {result && (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-3 gap-4 font-mono text-body-sm">
            <div className="rounded-md border border-white/10 bg-white/[0.02] px-4 py-3">
              <div className="text-moonbeem-ink-subtle uppercase tracking-wider text-caption">
                Imported
              </div>
              <div className="text-moonbeem-pink text-heading-md">
                {result.imported}
              </div>
            </div>
            <div className="rounded-md border border-white/10 bg-white/[0.02] px-4 py-3">
              <div className="text-moonbeem-ink-subtle uppercase tracking-wider text-caption">
                Duplicates
              </div>
              <div className="text-moonbeem-ink text-heading-md">
                {result.skipped_duplicates}
              </div>
            </div>
            <div className="rounded-md border border-white/10 bg-white/[0.02] px-4 py-3">
              <div className="text-moonbeem-ink-subtle uppercase tracking-wider text-caption">
                Invalid
              </div>
              <div
                className={`text-heading-md ${
                  result.skipped_invalid > 0
                    ? "text-moonbeem-magenta"
                    : "text-moonbeem-ink"
                }`}
              >
                {result.skipped_invalid}
              </div>
            </div>
          </div>

          {result.errors.length > 0 && (
            <div className="flex flex-col gap-2">
              <h3 className="text-body-lg font-semibold text-moonbeem-ink m-0">
                Per-row notes ({result.errors.length})
              </h3>
              <div className="overflow-x-auto">
                <table className="w-full border-collapse font-mono text-body-sm">
                  <thead>
                    <tr className="border-b border-white/10 text-left">
                      <th className="py-2 pr-4">Row</th>
                      <th className="py-2 pr-4">URL</th>
                      <th className="py-2 pr-4">Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.errors.map((e, idx) => (
                      <tr
                        key={`${e.row}-${idx}`}
                        className="border-b border-white/5 align-top"
                      >
                        <td className="py-2 pr-4">{e.row}</td>
                        <td className="py-2 pr-4 break-all max-w-xs">
                          {e.embed_url ?? "—"}
                        </td>
                        <td className="py-2 pr-4 break-words text-moonbeem-ink-muted">
                          {e.reason}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
