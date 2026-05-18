"use client";

// Bulk CSV upload — three phases:
//   1. Upload — admin picks a CSV, hits Preview
//   2. Preview — server returns per-row analysis; admin reviews,
//      overrides attribution per row, toggles skip
//   3. Commit — POST modified rows; poll job status every 2s
//
// Polling stops when status === 'completed' or 'failed'.

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

type PreviewRow = {
  idx: number;
  rawUrl: string;
  platform: string | null;
  contentId: string | null;
  normalizedUrl: string | null;
  handle: string | null;
  suggestedTitleQuery: string | null;
  suggestedYear: number | null;
  notes: string | null;
  suggestion: {
    titleId: string | null;
    titleName: string | null;
    titleSlug: string | null;
    year: number | null;
    distributor: string | null;
    confidence: "exact" | "fuzzy" | "none";
  };
  status: "ready" | "review" | "skip";
  error: string | null;
};

type PreviewResp = {
  ok: true;
  total: number;
  ready: number;
  review: number;
  skip: number;
  rows: PreviewRow[];
};

type JobRow = PreviewRow & {
  titleId: string | null;
  skip: boolean;
  outcome: "pending" | "ok" | "failed" | "skipped";
  reason: string | null;
  fanEditId: string | null;
};

type JobResp = {
  ok: true;
  job: {
    id: string;
    status: "pending" | "processing" | "completed" | "failed";
    total_rows: number;
    processed_rows: number;
    succeeded_count: number;
    failed_count: number;
    skipped_count: number;
    rows: JobRow[];
    completed_at: string | null;
  };
};

type SearchResult = {
  id: string;
  slug: string;
  title: string;
  year: number | null;
  distributor: string | null;
};

const POLL_INTERVAL_MS = 2000;

function platformLabel(p: string | null): string {
  if (p === "tiktok") return "TikTok";
  if (p === "instagram") return "Instagram";
  if (p === "twitter") return "X";
  if (p === "youtube") return "YouTube";
  return "—";
}

function StatusChip({ status }: { status: PreviewRow["status"] }) {
  const cfg =
    status === "ready"
      ? { label: "Ready", cls: "border-green-700 text-green-300" }
      : status === "review"
        ? { label: "Review", cls: "border-yellow-700 text-yellow-300" }
        : { label: "Skip", cls: "border-red-700 text-red-300" };
  return (
    <span
      className={`text-body-sm uppercase tracking-wider rounded-full border px-2 py-0.5 ${cfg.cls}`}
    >
      {cfg.label}
    </span>
  );
}

export default function BulkUploadClient() {
  const [file, setFile] = useState<File | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewResp | null>(null);

  // Admin overrides keyed by row idx. Holds title_id swap + skip flag.
  const [overrides, setOverrides] = useState<
    Map<number, { titleId?: string | null; titleLabel?: string; skip?: boolean }>
  >(new Map());

  // Per-row title search state.
  const [searchOpenIdx, setSearchOpenIdx] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const searchAbort = useRef<AbortController | null>(null);

  const [committing, setCommitting] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<JobResp["job"] | null>(null);

  // Debounced title search.
  useEffect(() => {
    if (searchOpenIdx === null) return;
    const q = searchQuery.trim();
    if (q.length < 2) {
      setSearchResults([]);
      return;
    }
    const t = window.setTimeout(async () => {
      searchAbort.current?.abort();
      const ctrl = new AbortController();
      searchAbort.current = ctrl;
      try {
        const res = await fetch(
          `/api/admin/titles/search?q=${encodeURIComponent(q)}&limit=10`,
          { signal: ctrl.signal },
        );
        if (!res.ok) return;
        const json = (await res.json()) as { results?: SearchResult[] };
        setSearchResults(json.results ?? []);
      } catch {
        // ignored
      }
    }, 300);
    return () => window.clearTimeout(t);
  }, [searchQuery, searchOpenIdx]);

  // Job polling.
  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    async function tick() {
      try {
        const res = await fetch(
          `/api/admin/fan-edits/bulk/jobs/${jobId}`,
        );
        if (!res.ok) return;
        const json = (await res.json()) as JobResp;
        if (cancelled) return;
        setJob(json.job);
        if (json.job.status === "completed" || json.job.status === "failed") {
          return; // stop
        }
        window.setTimeout(tick, POLL_INTERVAL_MS);
      } catch {
        if (!cancelled) window.setTimeout(tick, POLL_INTERVAL_MS);
      }
    }
    tick();
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  async function runPreview() {
    if (!file) return;
    setPreviewing(true);
    setPreviewError(null);
    setPreview(null);
    setOverrides(new Map());
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/admin/fan-edits/bulk/preview", {
        method: "POST",
        body: fd,
      });
      const json = await res.json();
      if (!res.ok) {
        setPreviewError(json.error ?? "preview failed");
        return;
      }
      setPreview(json as PreviewResp);
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : "preview failed");
    } finally {
      setPreviewing(false);
    }
  }

  function applyOverride(
    idx: number,
    patch: { titleId?: string | null; titleLabel?: string; skip?: boolean },
  ) {
    setOverrides((prev) => {
      const next = new Map(prev);
      const cur = next.get(idx) ?? {};
      next.set(idx, { ...cur, ...patch });
      return next;
    });
  }

  function resolvedRow(r: PreviewRow): {
    titleId: string | null;
    titleLabel: string | null;
    skip: boolean;
  } {
    const ov = overrides.get(r.idx);
    const titleId =
      ov?.titleId !== undefined ? ov.titleId : r.suggestion.titleId;
    const titleLabel =
      ov?.titleLabel !== undefined
        ? ov.titleLabel
        : r.suggestion.titleName
          ? `${r.suggestion.titleName}${
              r.suggestion.year ? ` (${r.suggestion.year})` : ""
            }`
          : null;
    const skip = ov?.skip ?? r.status === "skip";
    return { titleId, titleLabel, skip };
  }

  const committableRows = preview
    ? preview.rows.map((r) => {
        const res = resolvedRow(r);
        return {
          idx: r.idx,
          rawUrl: r.rawUrl,
          platform: r.platform,
          contentId: r.contentId,
          normalizedUrl: r.normalizedUrl,
          handle: r.handle,
          titleId: res.titleId,
          notes: r.notes,
          skip: res.skip || !res.titleId,
        };
      })
    : [];

  const counts = preview
    ? committableRows.reduce(
        (acc, r) => {
          if (r.skip) acc.skip++;
          else acc.commit++;
          return acc;
        },
        { commit: 0, skip: 0 },
      )
    : { commit: 0, skip: 0 };

  async function runCommit() {
    if (!preview) return;
    setCommitting(true);
    try {
      const res = await fetch("/api/admin/fan-edits/bulk/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: committableRows }),
      });
      const json = await res.json();
      if (!res.ok) {
        setPreviewError(json.error ?? "commit failed");
        setCommitting(false);
        return;
      }
      setJobId(json.job_id as string);
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : "commit failed");
      setCommitting(false);
    }
  }

  const jobDone =
    job && (job.status === "completed" || job.status === "failed");

  return (
    <div className="min-h-screen px-6 py-12 text-moonbeem-ink">
      <div className="max-w-5xl mx-auto flex flex-col gap-8">
        <div className="flex items-center justify-between gap-4">
          <div className="flex flex-col gap-2">
            <p className="text-body-sm text-moonbeem-ink-subtle uppercase tracking-wider">
              Admin — fan edits
            </p>
            <h1 className="font-wordmark font-bold text-display-md text-moonbeem-pink m-0">
              Bulk upload
            </h1>
            <p className="text-body-sm text-moonbeem-ink-muted">
              CSV columns: <code>url</code>, <code>suggested_title</code>{" "}
              (required); <code>suggested_year</code>,{" "}
              <code>creator_handle</code>, <code>notes</code> (optional). 100
              row limit per upload.
            </p>
          </div>
          <Link
            href="/admin/fan-edits/new"
            className="text-body-sm text-moonbeem-ink-muted hover:text-moonbeem-pink"
          >
            Add single →
          </Link>
        </div>

        {!preview && !job && (
          <div className="flex flex-col gap-3">
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="text-body-sm text-moonbeem-ink-muted file:mr-4 file:rounded-md file:border file:border-white/15 file:bg-transparent file:px-3 file:py-1.5 file:text-moonbeem-ink hover:file:border-moonbeem-pink"
            />
            <button
              type="button"
              onClick={runPreview}
              disabled={!file || previewing}
              className="self-start rounded-md bg-moonbeem-pink text-moonbeem-navy px-4 py-2 text-body font-semibold disabled:opacity-40 disabled:cursor-not-allowed hover:opacity-90"
            >
              {previewing ? "Parsing…" : "Preview"}
            </button>
            {previewError && (
              <p className="text-body-sm text-moonbeem-magenta">
                {previewError}
              </p>
            )}
          </div>
        )}

        {preview && !job && (
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-3">
              <p className="text-body-sm text-moonbeem-ink-muted">
                {preview.total} rows · {counts.commit} to commit ·{" "}
                {counts.skip} skip
              </p>
              <button
                type="button"
                onClick={runCommit}
                disabled={committing || counts.commit === 0}
                className="rounded-md bg-moonbeem-pink text-moonbeem-navy px-4 py-1.5 text-body-sm font-semibold disabled:opacity-40 disabled:cursor-not-allowed hover:opacity-90"
              >
                {committing
                  ? "Submitting…"
                  : `Add ${counts.commit} fan edit${counts.commit === 1 ? "" : "s"}`}
              </button>
              <button
                type="button"
                onClick={() => {
                  setPreview(null);
                  setFile(null);
                  setOverrides(new Map());
                }}
                className="text-body-sm text-moonbeem-ink-muted hover:text-moonbeem-pink"
              >
                Discard
              </button>
            </div>

            <div className="rounded-md border border-white/10 bg-white/[0.02] overflow-hidden">
              <table className="w-full text-body-sm">
                <thead className="bg-white/[0.04] text-moonbeem-ink-subtle uppercase tracking-wider">
                  <tr>
                    <th className="text-left p-2">#</th>
                    <th className="text-left p-2">Status</th>
                    <th className="text-left p-2">URL</th>
                    <th className="text-left p-2">Platform</th>
                    <th className="text-left p-2">Attribution</th>
                    <th className="text-left p-2">Confidence</th>
                    <th className="text-left p-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((r) => {
                    const res = resolvedRow(r);
                    return (
                      <tr
                        key={r.idx}
                        className="border-t border-white/5"
                      >
                        <td className="p-2 text-moonbeem-ink-subtle">
                          {r.idx + 1}
                        </td>
                        <td className="p-2">
                          {res.skip ? (
                            <StatusChip status="skip" />
                          ) : (
                            <StatusChip status={r.status} />
                          )}
                        </td>
                        <td className="p-2 max-w-xs">
                          <a
                            href={r.rawUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="block truncate text-moonbeem-ink hover:text-moonbeem-pink"
                            title={r.rawUrl}
                          >
                            {r.rawUrl || "—"}
                          </a>
                          {r.error && (
                            <p className="text-moonbeem-magenta text-xs">
                              {r.error}
                            </p>
                          )}
                        </td>
                        <td className="p-2">{platformLabel(r.platform)}</td>
                        <td className="p-2 max-w-xs">
                          {res.titleLabel ? (
                            <span className="text-moonbeem-ink">
                              {res.titleLabel}
                            </span>
                          ) : (
                            <span className="text-moonbeem-ink-subtle">
                              none
                            </span>
                          )}
                          {searchOpenIdx === r.idx && (
                            <div className="relative">
                              <input
                                type="text"
                                value={searchQuery}
                                onChange={(e) =>
                                  setSearchQuery(e.target.value)
                                }
                                placeholder="Search the catalog…"
                                className="w-full mt-1 bg-transparent border border-white/15 rounded px-2 py-1 text-moonbeem-ink"
                                autoFocus
                              />
                              {searchResults.length > 0 && (
                                <div className="absolute z-10 mt-1 w-72 rounded-md border border-white/15 bg-black shadow-lg max-h-60 overflow-y-auto">
                                  {searchResults.map((s) => (
                                    <button
                                      key={s.id}
                                      type="button"
                                      onClick={() => {
                                        applyOverride(r.idx, {
                                          titleId: s.id,
                                          titleLabel: `${s.title}${
                                            s.year ? ` (${s.year})` : ""
                                          }`,
                                          skip: false,
                                        });
                                        setSearchOpenIdx(null);
                                        setSearchQuery("");
                                        setSearchResults([]);
                                      }}
                                      className="block w-full text-left px-3 py-2 hover:bg-white/[0.05] border-b border-white/5 last:border-b-0"
                                    >
                                      <p className="text-moonbeem-ink">
                                        {s.title}
                                      </p>
                                      <p className="text-moonbeem-ink-subtle text-xs">
                                        {s.year ?? "—"} ·{" "}
                                        {s.distributor ?? "no distributor"}
                                      </p>
                                    </button>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}
                        </td>
                        <td className="p-2 text-moonbeem-ink-subtle">
                          {r.suggestion.confidence}
                        </td>
                        <td className="p-2 whitespace-nowrap">
                          <button
                            type="button"
                            onClick={() => {
                              if (searchOpenIdx === r.idx) {
                                setSearchOpenIdx(null);
                              } else {
                                setSearchOpenIdx(r.idx);
                                setSearchQuery(
                                  r.suggestedTitleQuery ?? "",
                                );
                              }
                            }}
                            className="text-xs text-moonbeem-ink-muted hover:text-moonbeem-pink"
                          >
                            Override
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              applyOverride(r.idx, { skip: !res.skip })
                            }
                            className="ml-2 text-xs text-moonbeem-ink-muted hover:text-moonbeem-pink"
                          >
                            {res.skip ? "Unskip" : "Skip"}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {job && (
          <div className="flex flex-col gap-4">
            <div>
              <p className="text-body text-moonbeem-ink">
                {jobDone
                  ? `Done. ${job.succeeded_count} added · ${job.failed_count} failed · ${job.skipped_count} skipped.`
                  : `Processing row ${job.processed_rows} of ${job.total_rows}…`}
              </p>
              {!jobDone && (
                <div className="h-1 w-full bg-white/10 rounded mt-2 overflow-hidden">
                  <div
                    className="h-full bg-moonbeem-pink transition-[width]"
                    style={{
                      width: `${
                        job.total_rows
                          ? Math.round(
                              (job.processed_rows / job.total_rows) * 100,
                            )
                          : 0
                      }%`,
                    }}
                  />
                </div>
              )}
            </div>

            {jobDone && (
              <div className="rounded-md border border-white/10 bg-white/[0.02] overflow-hidden">
                <table className="w-full text-body-sm">
                  <thead className="bg-white/[0.04] text-moonbeem-ink-subtle uppercase tracking-wider">
                    <tr>
                      <th className="text-left p-2">#</th>
                      <th className="text-left p-2">Outcome</th>
                      <th className="text-left p-2">URL</th>
                      <th className="text-left p-2">Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {job.rows.map((r) => (
                      <tr
                        key={r.idx}
                        className="border-t border-white/5"
                      >
                        <td className="p-2 text-moonbeem-ink-subtle">
                          {r.idx + 1}
                        </td>
                        <td className="p-2">
                          <span
                            className={`uppercase tracking-wider text-xs ${
                              r.outcome === "ok"
                                ? "text-green-300"
                                : r.outcome === "skipped"
                                  ? "text-yellow-300"
                                  : r.outcome === "failed"
                                    ? "text-moonbeem-magenta"
                                    : "text-moonbeem-ink-subtle"
                            }`}
                          >
                            {r.outcome}
                          </span>
                        </td>
                        <td className="p-2 max-w-xs">
                          <a
                            href={r.rawUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="block truncate text-moonbeem-ink hover:text-moonbeem-pink"
                          >
                            {r.rawUrl}
                          </a>
                        </td>
                        <td className="p-2 text-moonbeem-ink-muted">
                          {r.reason ?? ""}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {jobDone && (
              <button
                type="button"
                onClick={() => {
                  setJob(null);
                  setJobId(null);
                  setPreview(null);
                  setFile(null);
                  setOverrides(new Map());
                  setCommitting(false);
                }}
                className="self-start rounded-md border border-white/15 px-3 py-1.5 text-body-sm text-moonbeem-ink-muted hover:border-moonbeem-pink hover:text-moonbeem-pink"
              >
                Upload another
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
