"use client";

// Single-URL admin fan-edit upload.
//
// Phases:
//   1. URL entry — platform detected from host as you type
//   2. Metadata fetch — POSTs to /fetch-metadata, populates preview +
//      auto-resolves the social handle to a Moonbeem creator via
//      creator_socials
//   3. Attribution
//      a. Social attribution (read-only): "Posted by @<handle> on
//         <Platform>" — what the post says
//      b. Network attribution: auto-resolved creator with avatar, or
//         "no registered creator" + override picker against the
//         creators table
//      c. Title attribution (debounced search_titles_admin)
//   4. Submit → /single with attributed_creator_id when set
//
// The metrics returned by /fetch-metadata are cached and passed back
// to /single so the insert path doesn't re-fetch. Thumbnail is
// proxied to R2 at preview time so the <img> renders reliably.

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

type CreatorResult = {
  id: string;
  moonbeem_handle: string;
  display_name: string | null;
  avatar_url: string | null;
  user_id?: string | null;
  verified_at?: string | null;
};

type MetadataResponse = {
  ok: true;
  parsed: ParsedFanEditUrl;
  metrics: FetchEngagementResult;
  resolvedCreator: CreatorResult | null;
  sourceHandle: string | null;
  postTypeLabel: string | null;
};

const SEARCH_DEBOUNCE_MS = 300;
const MIN_QUERY_LEN = 2;
const CREATOR_MIN_QUERY_LEN = 1;

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

  // Network attribution. When null, save uses the auto-resolved
  // creator from metadata.resolvedCreator (if any). When set, it
  // overrides — and if metadata.resolvedCreator is also null this is
  // what flips us from Path 2 (stub) to Path 1 (direct).
  const [creatorOverride, setCreatorOverride] = useState<CreatorResult | null>(
    null,
  );
  const [creatorPickerOpen, setCreatorPickerOpen] = useState(false);
  const [creatorQuery, setCreatorQuery] = useState("");
  const [creatorResults, setCreatorResults] = useState<CreatorResult[]>([]);
  const [creatorSearching, setCreatorSearching] = useState(false);

  // Editable creator handle. Pre-fills from metadata.sourceHandle
  // when /fetch-metadata returns; admin can override before save.
  // Always-visible (every platform), so it doubles as a way to
  // correct a wrong URL-detected handle on TikTok/IG/X too.
  const [handleInput, setHandleInput] = useState("");

  const [notes, setNotes] = useState("");

  const [titleQuery, setTitleQuery] = useState("");
  const [titleResults, setTitleResults] = useState<TitleResult[]>([]);
  const [selectedTitle, setSelectedTitle] = useState<TitleResult | null>(null);
  const [titleSearching, setTitleSearching] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const titleSearchAbort = useRef<AbortController | null>(null);
  const creatorSearchAbort = useRef<AbortController | null>(null);

  // Reset handle input whenever a fresh metadata response arrives.
  // sourceHandle is the route's resolution chain
  // (parsed.handle → metrics.creator_handle_displayed → channelTitle
  // for YouTube), so this pre-fills with the best auto-detected
  // value. Admin sees it, accepts or edits.
  useEffect(() => {
    setHandleInput(metadata?.sourceHandle ?? "");
  }, [metadata?.sourceHandle]);

  // Detect platform as user types (cheap, no API call).
  useEffect(() => {
    if (!url.trim()) {
      setParsed(null);
      setParseError(null);
      return;
    }
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
      // ignore
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
      titleSearchAbort.current?.abort();
      const ctrl = new AbortController();
      titleSearchAbort.current = ctrl;
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
        if ((err as Error).name !== "AbortError") setTitleResults([]);
      } finally {
        setTitleSearching(false);
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [titleQuery]);

  // Debounced creator search.
  useEffect(() => {
    if (!creatorPickerOpen) return;
    const q = creatorQuery.trim();
    if (q.length < CREATOR_MIN_QUERY_LEN) {
      setCreatorResults([]);
      return;
    }
    const timer = window.setTimeout(async () => {
      creatorSearchAbort.current?.abort();
      const ctrl = new AbortController();
      creatorSearchAbort.current = ctrl;
      setCreatorSearching(true);
      try {
        const res = await fetch(
          `/api/admin/creators/search?q=${encodeURIComponent(q)}&limit=10`,
          { signal: ctrl.signal },
        );
        if (!res.ok) {
          setCreatorResults([]);
          return;
        }
        const json = (await res.json()) as { results?: CreatorResult[] };
        setCreatorResults(json.results ?? []);
      } catch (err) {
        if ((err as Error).name !== "AbortError") setCreatorResults([]);
      } finally {
        setCreatorSearching(false);
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [creatorQuery, creatorPickerOpen]);

  async function fetchMetadata() {
    if (!url.trim() || !parsed) return;
    setFetching(true);
    setMetadataError(null);
    setMetadata(null);
    setCreatorOverride(null);
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

  // Effective network attribution = override > auto-resolved > null.
  const effectiveCreator: CreatorResult | null =
    creatorOverride ?? metadata?.resolvedCreator ?? null;

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
          handle: handleInput.trim() || undefined,
          attributed_creator_id: effectiveCreator?.id ?? null,
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
      setCreatorOverride(null);
      setCreatorPickerOpen(false);
      setCreatorQuery("");
      setCreatorResults([]);
      setHandleInput("");
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

  const showTitleResults =
    titleResults.length > 0 && titleQuery.trim().length >= MIN_QUERY_LEN;

  return (
    <div className="min-h-screen px-6 py-12 text-moonbeem-ink">
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
                setCreatorOverride(null);
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
              We couldn&apos;t fetch metadata for this URL ({metadataError}).
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
                <p className="text-body-sm text-moonbeem-ink-muted">
                  {formatNumber(metadata.metrics.view_count)} views ·{" "}
                  {formatNumber(metadata.metrics.like_count)} likes ·{" "}
                  {formatNumber(metadata.metrics.comment_count)} comments
                </p>
                {metadata.postTypeLabel && (
                  <p className="text-body-sm text-moonbeem-ink-subtle">
                    {metadata.postTypeLabel}
                  </p>
                )}
                {metadata.metrics.posted_at && (
                  <p className="text-body-sm text-moonbeem-ink-subtle">
                    Posted{" "}
                    {new Date(metadata.metrics.posted_at).toLocaleDateString()}
                  </p>
                )}
                {metadata.metrics.error && (
                  <p className="text-body-sm text-moonbeem-magenta">
                    Import warning: {metadata.metrics.error}
                  </p>
                )}
              </div>
            </div>
          )}
        </div>

        {metadata && (
          <div className="flex flex-col gap-5">
            {/* Social attribution — editable. Pre-filled from the
                route's sourceHandle resolution chain; admin can
                accept or override (works for any platform, including
                fixing a wrong URL-detected handle). On save, blank
                falls back to parsed.handle server-side (typically
                null for YouTube without a /@channel/ segment); any
                non-blank value passes through verbatim, then
                insert.ts strips the leading @ and lowercases. */}
            <div className="flex flex-col gap-2 rounded-md border border-white/10 bg-white/[0.02] p-3">
              <span className="text-body-sm text-moonbeem-ink-subtle uppercase tracking-wider">
                Posted by
              </span>
              <div className="flex items-center gap-2">
                <span className="text-body text-moonbeem-ink-subtle">@</span>
                <input
                  type="text"
                  value={handleInput}
                  onChange={(e) => setHandleInput(e.target.value)}
                  placeholder={
                    metadata.sourceHandle
                      ? ""
                      : "handle not detected — enter to attribute"
                  }
                  className="flex-1 bg-transparent border border-white/15 rounded-md px-3 py-1.5 text-body text-moonbeem-ink placeholder:text-moonbeem-ink-subtle focus:outline-none focus:border-moonbeem-pink"
                />
                <span className="text-body-sm text-moonbeem-ink-subtle whitespace-nowrap">
                  on {platformLabel(metadata.parsed.platform)}
                </span>
              </div>
              {metadata.sourceHandle && (
                <p className="text-caption text-moonbeem-ink-subtle">
                  Auto-detected: @{metadata.sourceHandle}. Edit to
                  override.
                </p>
              )}
            </div>

            {/* Network attribution */}
            <div className="flex flex-col gap-2 rounded-md border border-white/10 bg-white/[0.02] p-3">
              <span className="text-body-sm text-moonbeem-ink-subtle uppercase tracking-wider">
                Attributed to
              </span>

              {effectiveCreator ? (
                <div className="flex items-center gap-3">
                  {effectiveCreator.avatar_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={effectiveCreator.avatar_url}
                      alt=""
                      width={40}
                      height={40}
                      className="rounded-full bg-black/40 object-cover"
                    />
                  ) : (
                    <div className="w-10 h-10 rounded-full bg-black/40 flex items-center justify-center text-body-sm text-moonbeem-ink-subtle">
                      {effectiveCreator.moonbeem_handle.slice(0, 1).toUpperCase()}
                    </div>
                  )}
                  <div className="flex flex-col min-w-0">
                    <p className="text-body text-moonbeem-ink">
                      {effectiveCreator.display_name ??
                        `@${effectiveCreator.moonbeem_handle}`}
                    </p>
                    <p className="text-body-sm text-moonbeem-ink-subtle">
                      @{effectiveCreator.moonbeem_handle}
                      {creatorOverride
                        ? " · admin override"
                        : metadata.resolvedCreator
                          ? " · auto-resolved from social handle"
                          : ""}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setCreatorOverride(null);
                      setCreatorPickerOpen(true);
                      setCreatorQuery("");
                    }}
                    className="ml-auto text-body-sm text-moonbeem-ink-muted hover:text-moonbeem-pink"
                  >
                    Change
                  </button>
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  <p className="text-body-sm text-moonbeem-ink-muted">
                    No registered Moonbeem creator for{" "}
                    {metadata.sourceHandle
                      ? `@${metadata.sourceHandle} on ${platformLabel(metadata.parsed.platform)}`
                      : `this ${platformLabel(metadata.parsed.platform)} post`}
                    . A stub creator will be created on save.
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      setCreatorPickerOpen(true);
                      setCreatorQuery("");
                    }}
                    className="self-start text-body-sm text-moonbeem-ink-muted hover:text-moonbeem-pink"
                  >
                    Attribute to existing creator →
                  </button>
                </div>
              )}

              {creatorPickerOpen && (
                <div className="relative">
                  <input
                    type="text"
                    value={creatorQuery}
                    onChange={(e) => setCreatorQuery(e.target.value)}
                    placeholder="Type a Moonbeem handle or name…"
                    autoFocus
                    className="w-full bg-transparent border border-white/15 rounded-md px-3 py-2 text-body text-moonbeem-ink placeholder:text-moonbeem-ink-subtle focus:outline-none focus:border-moonbeem-pink"
                  />
                  {creatorResults.length > 0 && (
                    <div className="absolute z-10 mt-1 w-full rounded-md border border-white/15 bg-black shadow-lg max-h-72 overflow-y-auto">
                      {creatorResults.map((c) => (
                        <button
                          key={c.id}
                          type="button"
                          onClick={() => {
                            setCreatorOverride(c);
                            setCreatorPickerOpen(false);
                            setCreatorQuery("");
                            setCreatorResults([]);
                          }}
                          className="block w-full text-left px-3 py-2 hover:bg-white/[0.05] border-b border-white/5 last:border-b-0"
                        >
                          <p className="text-body text-moonbeem-ink">
                            {c.display_name ?? `@${c.moonbeem_handle}`}
                          </p>
                          <p className="text-body-sm text-moonbeem-ink-subtle">
                            @{c.moonbeem_handle}
                          </p>
                        </button>
                      ))}
                    </div>
                  )}
                  {creatorSearching && (
                    <p className="text-body-sm text-moonbeem-ink-subtle mt-1">
                      Searching…
                    </p>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setCreatorPickerOpen(false);
                      setCreatorQuery("");
                      setCreatorResults([]);
                    }}
                    className="mt-1 text-body-sm text-moonbeem-ink-subtle hover:text-moonbeem-pink"
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>

            {/* Title attribution */}
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
                  {showTitleResults && (
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
                            {t.year ?? "—"} ·{" "}
                            {t.distributor ?? "no distributor"}
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
