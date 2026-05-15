"use client";

// Single-URL admin fan-edit upload. Three phases:
//   1. URL entry — platform detected from host as you type
//   2. Metadata fetch — POSTs to /fetch-metadata, populates preview
//   3. Attribution + submit — debounced title search, POST to /single
//
// The metrics returned by /fetch-metadata are kept in client state
// and passed back to /single so the insert path doesn't re-fetch.

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { ParsedFanEditUrl } from "@/lib/fan-edits/url-parser";
import type { FetchEngagementResult } from "@/lib/ensembledata/client";

type TitleResult = {
  id: string;
  slug: string;
  title: string;
  year: number | null;
  distributor: string | null;
};

type MetadataResponse = {
  ok: true;
  parsed: ParsedFanEditUrl;
  metrics: FetchEngagementResult;
};

const SEARCH_DEBOUNCE_MS = 300;
const MIN_QUERY_LEN = 2;

function formatNumber(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function platformLabel(p: string | null): string {
  if (p === "tiktok") return "TikTok";
  if (p === "instagram") return "Instagram";
  if (p === "twitter") return "X";
  if (p === "youtube") return "YouTube";
  return "—";
}

export default function SingleUploadClient() {
  const [url, setUrl] = useState("");
  const [parsed, setParsed] = useState<ParsedFanEditUrl | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);
  const [metadata, setMetadata] = useState<MetadataResponse | null>(null);
  const [metadataError, setMetadataError] = useState<string | null>(null);

  const [handleOverride, setHandleOverride] = useState("");
  const [notes, setNotes] = useState("");

  const [titleQuery, setTitleQuery] = useState("");
  const [titleResults, setTitleResults] = useState<TitleResult[]>([]);
  const [selectedTitle, setSelectedTitle] = useState<TitleResult | null>(null);
  const [titleSearching, setTitleSearching] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const searchAbort = useRef<AbortController | null>(null);

  // Detect platform as user types (cheap, no API call).
  useEffect(() => {
    if (!url.trim()) {
      setParsed(null);
      setParseError(null);
      return;
    }
    // Lazy-parse without hitting the server.
    let detected: ParsedFanEditUrl | null = null;
    try {
      const u = new URL(url.trim());
      const host = u.host.toLowerCase();
      const platform =
        host.includes("tiktok.com")
          ? "tiktok"
          : host.includes("instagram.com")
            ? "instagram"
            : host.includes("twitter.com") || host.includes("x.com")
              ? "twitter"
              : host.includes("youtube.com") || host.includes("youtu.be")
                ? "youtube"
                : null;
      if (platform) {
        detected = {
          platform,
          contentId: "",
          handle: null,
          normalizedUrl: `https://${u.host}${u.pathname.replace(/\/$/, "")}`,
        };
      }
    } catch {
      // ignore — parse error shown below if user keeps typing
    }
    setParsed(detected);
    setParseError(detected ? null : "URL not recognized");
  }, [url]);

  // Debounced title search.
  useEffect(() => {
    const q = titleQuery.trim();
    if (q.length < MIN_QUERY_LEN) {
      setTitleResults([]);
      setTitleSearching(false);
      return;
    }
    const timer = window.setTimeout(async () => {
      searchAbort.current?.abort();
      const ctrl = new AbortController();
      searchAbort.current = ctrl;
      setTitleSearching(true);
      try {
        const res = await fetch(
          `/api/admin/titles/search?q=${encodeURIComponent(q)}&limit=10`,
          { signal: ctrl.signal },
        );
        if (!res.ok) {
          setTitleResults([]);
          return;
        }
        const json = (await res.json()) as { results?: TitleResult[] };
        setTitleResults(json.results ?? []);
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          setTitleResults([]);
        }
      } finally {
        setTitleSearching(false);
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [titleQuery]);

  async function fetchMetadata() {
    if (!url.trim() || !parsed) return;
    setFetching(true);
    setMetadataError(null);
    setMetadata(null);
    try {
      const res = await fetch("/api/admin/fan-edits/fetch-metadata", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim() }),
      });
      const json = await res.json();
      if (!res.ok) {
        setMetadataError(json.error ?? "metadata fetch failed");
        return;
      }
      setMetadata(json as MetadataResponse);
    } catch (err) {
      setMetadataError(
        err instanceof Error ? err.message : "metadata fetch failed",
      );
    } finally {
      setFetching(false);
    }
  }

  async function submit() {
    if (!metadata || !selectedTitle) return;
    setSubmitting(true);
    setSubmitError(null);
    setSuccess(null);
    try {
      const res = await fetch("/api/admin/fan-edits/single", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: metadata.parsed.normalizedUrl,
          title_id: selectedTitle.id,
          handle: handleOverride.trim() || undefined,
          notes: notes.trim() || undefined,
          metrics: metadata.metrics,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setSubmitError(json.error ?? "submit failed");
        return;
      }
      setSuccess(`Added to ${selectedTitle.title}.`);
      // Reset for next entry.
      setUrl("");
      setParsed(null);
      setMetadata(null);
      setHandleOverride("");
      setNotes("");
      setTitleQuery("");
      setSelectedTitle(null);
      setTitleResults([]);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "submit failed");
    } finally {
      setSubmitting(false);
    }
  }

  const canSubmit =
    !!metadata && !!selectedTitle && !submitting && !fetching;

  const showResults =
    titleResults.length > 0 && titleQuery.trim().length >= MIN_QUERY_LEN;

  return (
    <div className="min-h-screen px-6 py-12 bg-[radial-gradient(ellipse_at_center,_#011754_0%,_#121212_100%)] text-moonbeem-ink">
      <div className="max-w-3xl mx-auto flex flex-col gap-8">
        <div className="flex items-center justify-between gap-4">
          <div className="flex flex-col gap-2">
            <p className="text-body-sm text-moonbeem-ink-subtle uppercase tracking-wider">
              Admin — fan edits
            </p>
            <h1 className="font-wordmark font-bold text-display-md text-moonbeem-pink m-0">
              Add single
            </h1>
            <p className="text-body-sm text-moonbeem-ink-muted">
              Paste a TikTok, Instagram, X, or YouTube URL.
            </p>
          </div>
          <Link
            href="/admin/fan-edits/upload"
            className="text-body-sm text-moonbeem-ink-muted hover:text-moonbeem-pink"
          >
            Bulk upload →
          </Link>
        </div>

        {success && (
          <div className="rounded-md border border-green-700 bg-green-950/40 px-3 py-2 text-body-sm text-green-300">
            {success}
          </div>
        )}

        <div className="flex flex-col gap-4">
          <label className="flex flex-col gap-1">
            <span className="text-body-sm text-moonbeem-ink-muted">URL</span>
            <input
              type="url"
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                setMetadata(null);
                setMetadataError(null);
              }}
              placeholder="https://www.tiktok.com/@handle/video/..."
              className={`w-full bg-transparent border ${
                parseError && url.trim()
                  ? "border-moonbeem-magenta"
                  : "border-white/15"
              } rounded-md px-3 py-2 text-body text-moonbeem-ink placeholder:text-moonbeem-ink-subtle focus:outline-none focus:border-moonbeem-pink`}
            />
            <span className="text-body-sm text-moonbeem-ink-subtle">
              Detected: {platformLabel(parsed?.platform ?? null)}
            </span>
          </label>

          <button
            type="button"
            onClick={fetchMetadata}
            disabled={!parsed || fetching}
            className="self-start rounded-md border border-white/15 px-3 py-1.5 text-body-sm text-moonbeem-ink-muted hover:border-moonbeem-pink hover:text-moonbeem-pink disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {fetching ? "Fetching…" : "Fetch metadata"}
          </button>

          {metadataError && (
            <p className="text-body-sm text-moonbeem-magenta">
              We couldn&apos;t fetch metadata for this URL ({metadataError}). You
              can still proceed; counts will populate on the next view-tracking
              sweep.
            </p>
          )}

          {metadata && (
            <div className="flex gap-4 rounded-md border border-white/10 bg-white/[0.02] p-4">
              {metadata.metrics.thumbnail_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={metadata.metrics.thumbnail_url}
                  alt=""
                  width={120}
                  height={120}
                  className="rounded-md object-cover bg-black/40"
                />
              ) : (
                <div className="w-[120px] h-[120px] rounded-md bg-black/40 flex items-center justify-center text-body-sm text-moonbeem-ink-subtle">
                  no thumb
                </div>
              )}
              <div className="flex flex-col gap-1 min-w-0">
                <p className="text-body-sm text-moonbeem-ink-subtle uppercase tracking-wider">
                  {platformLabel(metadata.parsed.platform)} ·{" "}
                  {metadata.parsed.contentId}
                </p>
                <p className="text-body text-moonbeem-ink">
                  @
                  {metadata.parsed.handle ??
                    metadata.metrics.creator_handle_displayed ??
                    "unknown"}
                </p>
                <p className="text-body-sm text-moonbeem-ink-muted">
                  {formatNumber(metadata.metrics.view_count)} views ·{" "}
                  {formatNumber(metadata.metrics.like_count)} likes ·{" "}
                  {formatNumber(metadata.metrics.comment_count)} comments
                </p>
                {metadata.metrics.posted_at && (
                  <p className="text-body-sm text-moonbeem-ink-subtle">
                    Posted{" "}
                    {new Date(metadata.metrics.posted_at).toLocaleDateString()}
                  </p>
                )}
                {metadata.metrics.error && (
                  <p className="text-body-sm text-moonbeem-magenta">
                    EnsembleData warning: {metadata.metrics.error}
                  </p>
                )}
              </div>
            </div>
          )}
        </div>

        {metadata && (
          <div className="flex flex-col gap-4">
            <label className="flex flex-col gap-1">
              <span className="text-body-sm text-moonbeem-ink-muted">
                Handle override (optional)
              </span>
              <input
                type="text"
                value={handleOverride}
                onChange={(e) => setHandleOverride(e.target.value)}
                placeholder={
                  metadata.parsed.handle ??
                  metadata.metrics.creator_handle_displayed ??
                  ""
                }
                className="w-full bg-transparent border border-white/15 rounded-md px-3 py-2 text-body text-moonbeem-ink placeholder:text-moonbeem-ink-subtle focus:outline-none focus:border-moonbeem-pink"
              />
            </label>

            <div className="flex flex-col gap-1">
              <span className="text-body-sm text-moonbeem-ink-muted">
                Attribute to title
              </span>
              {selectedTitle ? (
                <div className="flex items-center gap-2 self-start rounded-full border border-moonbeem-pink/40 bg-moonbeem-pink/10 px-3 py-1">
                  <span className="text-body-sm text-moonbeem-pink">
                    {selectedTitle.title}
                    {selectedTitle.year ? ` (${selectedTitle.year})` : ""}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedTitle(null);
                      setTitleQuery("");
                    }}
                    className="text-body-sm text-moonbeem-pink hover:text-moonbeem-magenta"
                    aria-label="Remove title attribution"
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
                  {showResults && (
                    <div className="absolute z-10 mt-1 w-full rounded-md border border-white/15 bg-black shadow-lg max-h-72 overflow-y-auto">
                      {titleResults.map((t) => (
                        <button
                          key={t.id}
                          type="button"
                          onClick={() => {
                            setSelectedTitle(t);
                            setTitleQuery("");
                            setTitleResults([]);
                          }}
                          className="block w-full text-left px-3 py-2 hover:bg-white/[0.05] border-b border-white/5 last:border-b-0"
                        >
                          <p className="text-body text-moonbeem-ink">
                            {t.title}
                          </p>
                          <p className="text-body-sm text-moonbeem-ink-subtle">
                            {t.year ?? "—"} · {t.distributor ?? "no distributor"}
                          </p>
                        </button>
                      ))}
                    </div>
                  )}
                  {titleSearching && (
                    <p className="text-body-sm text-moonbeem-ink-subtle mt-1">
                      Searching…
                    </p>
                  )}
                </div>
              )}
            </div>

            <label className="flex flex-col gap-1">
              <span className="text-body-sm text-moonbeem-ink-muted">
                Notes (optional)
              </span>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={3}
                className="w-full bg-transparent border border-white/15 rounded-md px-3 py-2 text-body text-moonbeem-ink placeholder:text-moonbeem-ink-subtle focus:outline-none focus:border-moonbeem-pink"
              />
            </label>

            {submitError && (
              <p className="text-body-sm text-moonbeem-magenta">
                {submitError}
              </p>
            )}

            <button
              type="button"
              onClick={submit}
              disabled={!canSubmit}
              className="self-start rounded-md bg-moonbeem-pink text-moonbeem-navy px-4 py-2 text-body font-semibold disabled:opacity-40 disabled:cursor-not-allowed hover:opacity-90 transition-opacity"
            >
              {submitting ? "Adding…" : "Add to catalog"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
