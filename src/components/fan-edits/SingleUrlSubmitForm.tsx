"use client";

// Single-URL fan-edit submission form. Extracted verbatim from
// UploadClient's SingleTab so it can be reused on the public campaign
// page (/t/[slug]/campaign) with a pinned title.
//
// Modes:
//   - pinnedTitle: fixed, non-removable attribution; the title
//     autocomplete is hidden entirely (campaign page).
//   - initialTitle: a removable seed selection (the upload page's
//     ?title_id prefill) — behaves identically to the pre-extraction form.
//   - neither: free title search, identical to today.
//
// The POST to /api/me/fan-edits/single is byte-identical in every mode:
// { url, title_id, metrics }.

import { useEffect, useRef, useState } from "react";
import type { ParsedFanEditUrl } from "@/lib/fan-edits/url-parser";
import type { FetchEngagementResult } from "@/lib/ensembledata/client";

type TitleRef = { id: string; name: string };

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
  sourceHandle: string | null;
  postTypeLabel: string | null;
};

type Props = {
  // Fixed, non-removable attribution. Hides the title autocomplete.
  pinnedTitle?: TitleRef;
  // Removable seed selection (upload-page ?title_id prefill).
  initialTitle?: TitleRef;
  // Display-only success banner copy. Defaults to the upload-page copy so
  // the upload surface stays byte-identical.
  successMessage?: string;
  // Optional client callback fired after a successful submit.
  onSuccess?: () => void;
};

const SEARCH_DEBOUNCE_MS = 300;
const MIN_QUERY_LEN = 2;
const DEFAULT_SUCCESS =
  "Submitted. We aim to respond within 24 hours. You'll receive an email when approved or rejected.";

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

// CF-3 (Part 2): friendly copy for the per-platform gate's reason codes.
// Raw codes stay internal (logged at the call site); only this text reaches
// the UI. Collab-agnostic — SEC-2 handles collaborator matching separately.
function friendlySubmitError(
  json: {
    error?: string;
    detail?: { platform?: string; expected?: string[]; got?: string };
  },
  submittedPlatform: string | null,
): string {
  const code = json.error;
  const detail = json.detail;
  const platform = platformLabel(detail?.platform ?? submittedPlatform ?? null);
  if (code === "platform_not_verified") {
    return `You haven't verified a ${platform} account yet. Verify one in your profile to submit edits from ${platform}.`;
  }
  if (code === "handle_mismatch" && detail) {
    const expected = (detail.expected ?? []).map((h) => `@${h}`).join(", ");
    return `This post is credited to @${detail.got}. You can submit edits from accounts you've verified: ${expected}.`;
  }
  return code ?? "submit failed";
}

export default function SingleUrlSubmitForm({
  pinnedTitle,
  initialTitle,
  successMessage,
  onSuccess,
}: Props) {
  const isPinned = !!pinnedTitle;
  const seed = pinnedTitle ?? initialTitle ?? null;

  const [url, setUrl] = useState("");
  const [parsed, setParsed] = useState<ParsedFanEditUrl | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);
  const [metadata, setMetadata] = useState<MetadataResponse | null>(null);
  const [metadataError, setMetadataError] = useState<string | null>(null);

  const [titleQuery, setTitleQuery] = useState("");
  const [titleResults, setTitleResults] = useState<TitleResult[]>([]);
  const [selectedTitle, setSelectedTitle] = useState<{
    id: string;
    label: string;
  } | null>(seed ? { id: seed.id, label: seed.name } : null);
  const [titleSearching, setTitleSearching] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const searchAbort = useRef<AbortController | null>(null);

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

  useEffect(() => {
    // Title search is disabled in pinned mode.
    if (isPinned) return;
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
          `/api/search?q=${encodeURIComponent(q)}`,
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
  }, [titleQuery, isPinned]);

  async function fetchMetadata() {
    if (!url.trim() || !parsed) return;
    setFetching(true);
    setMetadataError(null);
    setMetadata(null);
    try {
      const res = await fetch("/api/me/fan-edits/fetch-metadata", {
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
      const res = await fetch("/api/me/fan-edits/single", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: metadata.parsed.normalizedUrl,
          title_id: selectedTitle.id,
          metrics: metadata.metrics,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        // Raw reason codes are internal — log them, render friendly copy.
        console.debug("[fan-edit submit] gate reject", json.error, json.detail);
        setSubmitError(friendlySubmitError(json, metadata.parsed.platform));
        return;
      }
      setSuccess(successMessage ?? DEFAULT_SUCCESS);
      setUrl("");
      setParsed(null);
      setMetadata(null);
      setTitleQuery("");
      // Keep the attribution when it's pinned or seeded; otherwise clear
      // it (mirrors the pre-extraction `if (!prefillTitleId)` reset).
      if (!isPinned && !initialTitle) setSelectedTitle(null);
      onSuccess?.();
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
    <div className="flex flex-col gap-6">
      {success && (
        <div className="rounded-md border border-green-700 bg-green-950/40 px-3 py-2 text-body-sm text-green-300">
          {success}
        </div>
      )}

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
          placeholder="Paste a TikTok, Instagram, X, or YouTube URL"
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
        <p className="text-body-sm text-moonbeem-magenta">{metadataError}</p>
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
              @{metadata.sourceHandle ?? "unknown"}
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
          </div>
        </div>
      )}

      {metadata && (
        <div className="flex flex-col gap-1">
          <span className="text-body-sm text-moonbeem-ink-muted">
            Attribute to title
          </span>
          {isPinned ? (
            <div className="flex items-center gap-2 self-start rounded-full border border-moonbeem-pink/40 bg-moonbeem-pink/10 px-3 py-1">
              <span className="text-body-sm text-moonbeem-pink">
                {selectedTitle?.label}
              </span>
            </div>
          ) : selectedTitle ? (
            <div className="flex items-center gap-2 self-start rounded-full border border-moonbeem-pink/40 bg-moonbeem-pink/10 px-3 py-1">
              <span className="text-body-sm text-moonbeem-pink">
                {selectedTitle.label}
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
                        setSelectedTitle({
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
              {titleSearching && (
                <p className="text-body-sm text-moonbeem-ink-subtle mt-1">
                  Searching…
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {submitError && (
        <p className="text-body-sm text-moonbeem-magenta">{submitError}</p>
      )}

      {metadata && (
        <button
          type="button"
          onClick={submit}
          disabled={!canSubmit}
          className="self-start rounded-md bg-moonbeem-pink text-moonbeem-navy px-4 py-2 text-body font-semibold disabled:opacity-40 disabled:cursor-not-allowed hover:opacity-90 transition-opacity"
        >
          {submitting ? "Submitting…" : "Submit for review"}
        </button>
      )}
    </div>
  );
}
