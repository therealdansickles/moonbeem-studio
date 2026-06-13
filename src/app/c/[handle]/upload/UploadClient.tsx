"use client";

// Two tabs: Single URL (matches admin single-URL UX) and Multi URL
// (textarea → preview → async submit with polling).
//
// All metadata fetches go through /api/me/fan-edits/fetch-metadata
// which gates verified-only server-side. Submissions create
// verification_status='pending' rows; admin queue at
// /admin/fan-edits/queue reviews them.

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import SingleUrlSubmitForm from "@/components/fan-edits/SingleUrlSubmitForm";

type TitleResult = {
  id: string;
  slug: string;
  title: string;
  year: number | null;
  distributor: string | null;
};

type Props = {
  handle: string;
  prefillTitleId: string | null;
  prefillTitleLabel: string | null;
};

const SEARCH_DEBOUNCE_MS = 300;
const MIN_QUERY_LEN = 2;
const MULTI_URL_MAX = 25;

function platformLabel(p: string | null): string {
  if (p === "tiktok") return "TikTok";
  if (p === "instagram") return "Instagram";
  if (p === "twitter") return "X";
  if (p === "youtube") return "YouTube";
  return "—";
}

export default function UploadClient({
  handle,
  prefillTitleId,
  prefillTitleLabel,
}: Props) {
  const [tab, setTab] = useState<"single" | "multi">("single");

  return (
    <div className="min-h-screen px-6 py-12 text-moonbeem-ink">
      <div className="max-w-3xl mx-auto flex flex-col gap-8">
        <div className="flex items-center justify-between gap-4">
          <div className="flex flex-col gap-2">
            <p className="text-body-sm text-moonbeem-ink-subtle uppercase tracking-wider">
              Add fan edit
            </p>
            <h1 className="font-wordmark font-bold text-display-sm md:text-display-md text-moonbeem-pink m-0">
              @{handle}
            </h1>
            <p className="text-body-sm text-moonbeem-ink-muted">
              Submissions go to admin review. We aim to respond within 24 hours.
            </p>
          </div>
          <Link
            href={`/c/${handle}`}
            className="text-body-sm text-moonbeem-ink-muted hover:text-moonbeem-pink"
          >
            ← Profile
          </Link>
        </div>

        <div className="flex gap-1 border-b border-white/10">
          <button
            type="button"
            onClick={() => setTab("single")}
            className={`px-4 py-2 text-body-sm transition-colors ${
              tab === "single"
                ? "text-moonbeem-pink border-b-2 border-moonbeem-pink"
                : "text-moonbeem-ink-muted hover:text-moonbeem-ink"
            }`}
          >
            Single URL
          </button>
          <button
            type="button"
            onClick={() => setTab("multi")}
            className={`px-4 py-2 text-body-sm transition-colors ${
              tab === "multi"
                ? "text-moonbeem-pink border-b-2 border-moonbeem-pink"
                : "text-moonbeem-ink-muted hover:text-moonbeem-ink"
            }`}
          >
            Multiple URLs
          </button>
        </div>

        {tab === "single" ? (
          <SingleTab
            prefillTitleId={prefillTitleId}
            prefillTitleLabel={prefillTitleLabel}
          />
        ) : (
          <MultiTab
            prefillTitleId={prefillTitleId}
            prefillTitleLabel={prefillTitleLabel}
          />
        )}
      </div>
    </div>
  );
}

function SingleTab({
  prefillTitleId,
  prefillTitleLabel,
}: {
  prefillTitleId: string | null;
  prefillTitleLabel: string | null;
}) {
  // Thin wrapper around the shared SingleUrlSubmitForm. The upload page's
  // ?title_id prefill maps to a removable seed selection (initialTitle),
  // preserving the pre-extraction behaviour exactly.
  return (
    <SingleUrlSubmitForm
      initialTitle={
        prefillTitleId && prefillTitleLabel
          ? { id: prefillTitleId, name: prefillTitleLabel }
          : undefined
      }
    />
  );
}

type PreviewRow = {
  idx: number;
  rawUrl: string;
  platform: string | null;
  contentId: string | null;
  normalizedUrl: string | null;
  handle: string | null;
  status: "ready" | "review" | "skip";
  error: string | null;
};

type JobRow = PreviewRow & {
  titleId: string | null;
  skip: boolean;
  outcome: "pending" | "ok" | "failed" | "skipped";
  reason: string | null;
};

function MultiTab({
  prefillTitleId,
  prefillTitleLabel,
}: {
  prefillTitleId: string | null;
  prefillTitleLabel: string | null;
}) {
  const [text, setText] = useState("");
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ rows: PreviewRow[] } | null>(null);

  const [defaultTitle, setDefaultTitle] = useState<{
    id: string;
    label: string;
  } | null>(
    prefillTitleId && prefillTitleLabel
      ? { id: prefillTitleId, label: prefillTitleLabel }
      : null,
  );
  const [titleQuery, setTitleQuery] = useState("");
  const [titleResults, setTitleResults] = useState<TitleResult[]>([]);

  // overrides per row: { idx: { titleId, titleLabel, skip } }
  const [overrides, setOverrides] = useState<
    Map<number, { titleId?: string | null; titleLabel?: string; skip?: boolean }>
  >(new Map());

  const [committing, setCommitting] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<{
    status: string;
    total_rows: number;
    processed_rows: number;
    succeeded_count: number;
    failed_count: number;
    skipped_count: number;
    rows: JobRow[];
    completed_at: string | null;
  } | null>(null);

  const searchAbort = useRef<AbortController | null>(null);

  useEffect(() => {
    const q = titleQuery.trim();
    if (q.length < MIN_QUERY_LEN) {
      setTitleResults([]);
      return;
    }
    const t = window.setTimeout(async () => {
      searchAbort.current?.abort();
      const ctrl = new AbortController();
      searchAbort.current = ctrl;
      try {
        const res = await fetch(
          `/api/search?q=${encodeURIComponent(q)}`,
          { signal: ctrl.signal },
        );
        if (!res.ok) return;
        const json = (await res.json()) as { results?: TitleResult[] };
        setTitleResults(json.results ?? []);
      } catch {
        // ignored
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [titleQuery]);

  // Job polling
  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    async function tick() {
      try {
        const res = await fetch(`/api/me/fan-edits/bulk/jobs/${jobId}`);
        if (!res.ok) return;
        const json = await res.json();
        if (cancelled) return;
        setJob(json.job);
        if (json.job.status === "completed" || json.job.status === "failed") return;
        window.setTimeout(tick, 2000);
      } catch {
        if (!cancelled) window.setTimeout(tick, 2000);
      }
    }
    tick();
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  async function runPreview() {
    const urls = text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (urls.length === 0) {
      setPreviewError("Paste at least one URL");
      return;
    }
    if (urls.length > MULTI_URL_MAX) {
      setPreviewError(`${MULTI_URL_MAX} URL limit (got ${urls.length})`);
      return;
    }
    setPreviewing(true);
    setPreviewError(null);
    setPreview(null);
    setOverrides(new Map());
    try {
      const res = await fetch("/api/me/fan-edits/bulk/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urls }),
      });
      const json = await res.json();
      if (!res.ok) {
        setPreviewError(json.error ?? "preview failed");
        return;
      }
      setPreview({ rows: json.rows as PreviewRow[] });
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
      ov?.titleId !== undefined ? ov.titleId : defaultTitle?.id ?? null;
    const titleLabel =
      ov?.titleLabel !== undefined
        ? ov.titleLabel
        : defaultTitle?.label ?? null;
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
          skip: res.skip || !res.titleId,
        };
      })
    : [];

  const commitCount = committableRows.filter((r) => !r.skip).length;
  const skipCount = committableRows.filter((r) => r.skip).length;

  async function runCommit() {
    if (!preview) return;
    setCommitting(true);
    try {
      const res = await fetch("/api/me/fan-edits/bulk/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: committableRows }),
      });
      const json = await res.json();
      if (!res.ok) {
        setPreviewError(json.error ?? "submit failed");
        setCommitting(false);
        return;
      }
      setJobId(json.job_id as string);
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : "submit failed");
      setCommitting(false);
    }
  }

  const jobDone =
    job && (job.status === "completed" || job.status === "failed");

  return (
    <div className="flex flex-col gap-5">
      {!preview && !job && (
        <>
          <label className="flex flex-col gap-1">
            <span className="text-body-sm text-moonbeem-ink-muted">
              URLs (one per line, max {MULTI_URL_MAX})
            </span>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={10}
              placeholder="https://www.tiktok.com/@you/video/...&#10;https://www.instagram.com/reel/..."
              className="w-full bg-transparent border border-white/15 rounded-md px-3 py-2 text-body text-moonbeem-ink placeholder:text-moonbeem-ink-subtle focus:outline-none focus:border-moonbeem-pink"
            />
          </label>
          <div className="flex flex-col gap-1">
            <span className="text-body-sm text-moonbeem-ink-muted">
              Default title (applies to all rows — override per row after preview)
            </span>
            {defaultTitle ? (
              <div className="flex items-center gap-2 self-start rounded-full border border-moonbeem-pink/40 bg-moonbeem-pink/10 px-3 py-1">
                <span className="text-body-sm text-moonbeem-pink">
                  {defaultTitle.label}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setDefaultTitle(null);
                    setTitleQuery("");
                  }}
                  className="text-body-sm text-moonbeem-pink hover:text-moonbeem-magenta"
                >
                  ×
                </button>
              </div>
            ) : (
              <div className="relative">
                <input
                  type="text"
                  value={titleQuery}
                  onChange={(e) => setTitleQuery(e.target.value)}
                  placeholder="Search the catalog…"
                  className="w-full bg-transparent border border-white/15 rounded-md px-3 py-2 text-body text-moonbeem-ink placeholder:text-moonbeem-ink-subtle focus:outline-none focus:border-moonbeem-pink"
                />
                {titleResults.length > 0 && (
                  <div className="absolute z-10 mt-1 w-full rounded-md border border-white/15 bg-black shadow-lg max-h-72 overflow-y-auto">
                    {titleResults.map((t) => (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => {
                          setDefaultTitle({
                            id: t.id,
                            label: t.year ? `${t.title} (${t.year})` : t.title,
                          });
                          setTitleQuery("");
                          setTitleResults([]);
                        }}
                        className="block w-full text-left px-3 py-2 hover:bg-white/[0.05] border-b border-white/5 last:border-b-0"
                      >
                        <p className="text-body text-moonbeem-ink">{t.title}</p>
                        <p className="text-body-sm text-moonbeem-ink-subtle">
                          {t.year ?? "—"} · {t.distributor ?? "no distributor"}
                        </p>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={runPreview}
            disabled={!text.trim() || previewing}
            className="self-start rounded-md bg-moonbeem-pink text-moonbeem-navy px-4 py-2 text-body font-semibold disabled:opacity-40 hover:opacity-90"
          >
            {previewing ? "Parsing…" : "Preview"}
          </button>
          {previewError && (
            <p className="text-body-sm text-moonbeem-magenta">{previewError}</p>
          )}
        </>
      )}

      {preview && !job && (
        <>
          <div className="flex items-center gap-3">
            <p className="text-body-sm text-moonbeem-ink-muted">
              {preview.rows.length} rows · {commitCount} to submit ·{" "}
              {skipCount} skip
            </p>
            <button
              type="button"
              onClick={runCommit}
              disabled={committing || commitCount === 0}
              className="rounded-md bg-moonbeem-pink text-moonbeem-navy px-4 py-1.5 text-body-sm font-semibold disabled:opacity-40 hover:opacity-90"
            >
              {committing ? "Submitting…" : `Submit ${commitCount} for review`}
            </button>
            <button
              type="button"
              onClick={() => {
                setPreview(null);
                setText("");
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
                  <th className="text-left p-2">URL</th>
                  <th className="text-left p-2">Platform</th>
                  <th className="text-left p-2">Title</th>
                  <th className="text-left p-2"></th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((r) => {
                  const res = resolvedRow(r);
                  return (
                    <tr key={r.idx} className="border-t border-white/5">
                      <td className="p-2 text-moonbeem-ink-subtle">
                        {r.idx + 1}
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
                            none — set default above
                          </span>
                        )}
                      </td>
                      <td className="p-2 whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() =>
                            applyOverride(r.idx, { skip: !res.skip })
                          }
                          className="text-xs text-moonbeem-ink-muted hover:text-moonbeem-pink"
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
        </>
      )}

      {job && (
        <div className="flex flex-col gap-4">
          <div>
            <p className="text-body text-moonbeem-ink">
              {jobDone
                ? `Done. ${job.succeeded_count} submitted · ${job.failed_count} failed · ${job.skipped_count} skipped.`
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
            <>
              <p className="text-body-sm text-moonbeem-ink-muted">
                Submissions are pending admin review. We aim to respond within
                24 hours. You'll get an email when each one is approved or
                rejected.
              </p>
              <Link
                href="/me"
                className="self-start rounded-md border border-white/15 px-3 py-1.5 text-body-sm text-moonbeem-ink-muted hover:border-moonbeem-pink hover:text-moonbeem-pink"
              >
                Back to /me
              </Link>
            </>
          )}
        </div>
      )}
    </div>
  );
}
