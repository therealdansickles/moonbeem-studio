"use client";

import { useEffect, useMemo, useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";

type CandidatePlatform = "tiktok" | "youtube";

type Candidate = {
  platform: CandidatePlatform;
  post_id: string;
  post_url: string;
  caption: string;
  posted_at: number; // Unix seconds; 0 = unknown (YouTube only)
  // Pre-formatted relative time from sources that don't return a
  // timestamp (YouTube videoRenderer's publishedTimeText). Null for
  // TikTok and YT shorts.
  posted_relative: string | null;
  view_count: number;
  // Nullable across platforms (YouTube search doesn't expose these
  // server-side; YT parser sets 0 per spec). Type stays nullable for
  // future platforms that legitimately return null.
  like_count: number | null;
  comment_count: number | null;
  share_count: number | null;
  save_count: number | null;
  // Nullable: YouTube shorts have no channel info in search response.
  author_handle: string | null;
  author_display_name: string | null;
  // Pre-constructed channel URL from the source (YouTube provides this
  // via canonicalBaseUrl). When present, UI uses it directly for the
  // author link instead of building from author_handle — necessary
  // because YT display name (e.g. "Rotten Tomatoes Trailers") differs
  // from the URL-safe @-handle.
  author_url: string | null;
  author_avatar_url: string | null;
  thumbnail_url: string | null;
  hashtags: string[];
  is_video: boolean;
  already_in_library: boolean;
};

type SearchResponse = {
  ok: boolean;
  candidates: Candidate[];
  units_estimated: number;
  pages_fetched: number;
  results_count: number;
  warning: string | null;
  debug?: { raw_payload_truncated: string };
  error?: string;
};

type AddResponse = {
  ok: boolean;
  added: number;
  duplicate: number;
  failed: number;
  results: Array<{
    embed_url: string;
    outcome: "added" | "duplicate" | "failed";
    inserted_id?: string;
    existing_id?: string;
    error?: string;
  }>;
  error?: string;
};

type RowState = "new" | "adding" | "added" | "duplicate" | "failed";
type SortKey = "views" | "posted_at" | "engagement";

type Props = {
  titleSlug: string;
  titleName: string;
};

type PlatformOption = {
  id: "tiktok" | "youtube" | "instagram" | "twitter";
  label: string;
  enabled: boolean;
  // Hint shown for disabled platforms — tooltip on hover.
  disabledReason?: string;
  // Hint shown above the query input when this platform is selected
  // (e.g. "Type a hashtag for YouTube" vs "Type keyword(s) for TikTok").
  queryHint?: string;
};

const PLATFORMS: ReadonlyArray<PlatformOption> = [
  {
    id: "tiktok",
    label: "TikTok",
    enabled: true,
    queryHint: "keyword (e.g. film name)",
  },
  {
    id: "youtube",
    label: "YouTube",
    enabled: true,
    queryHint: "hashtag (with or without leading #)",
  },
  {
    id: "instagram",
    label: "Instagram",
    enabled: false,
    disabledReason:
      "EnsembleData doesn't currently support hashtag/keyword search for Instagram. Roadmap item pending vendor evaluation.",
  },
  {
    id: "twitter",
    label: "Twitter / X",
    enabled: false,
    disabledReason:
      "EnsembleData doesn't currently support keyword search for Twitter. Roadmap item pending vendor evaluation.",
  },
];

const MAX_RESULTS_OPTIONS = [20, 30, 50] as const;

export default function DiscoverTab({ titleSlug, titleName }: Props) {
  const router = useRouter();
  const [query, setQuery] = useState(titleName);
  const [platform, setPlatform] = useState<CandidatePlatform>("tiktok");
  const [maxResults, setMaxResults] = useState<20 | 30 | 50>(30);

  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [lastSearch, setLastSearch] = useState<{
    at: string;
    count: number;
    units: number;
    warning: string | null;
    debug: { raw_payload_truncated: string } | null;
  } | null>(null);

  const [rowState, setRowState] = useState<Record<string, RowState>>({});
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("views");

  const [urlInput, setUrlInput] = useState("");
  const [urlBusy, setUrlBusy] = useState(false);
  const [urlMessage, setUrlMessage] = useState<
    { kind: "ok" | "error"; text: string } | null
  >(null);

  // Re-rank when sort changes; keep already_in_library at the end.
  const sortedCandidates = useMemo(() => {
    const copy = [...candidates];
    copy.sort((a, b) => {
      if (a.already_in_library !== b.already_in_library) {
        return a.already_in_library ? 1 : -1;
      }
      switch (sortKey) {
        case "views":
          return b.view_count - a.view_count;
        case "posted_at":
          return b.posted_at - a.posted_at;
        case "engagement": {
          // Simple ratio: (likes+comments+shares) / views. Posts with
          // no views fall to the bottom. YouTube has null engagement
          // counts (search response doesn't expose them) — those rows
          // sort below TikTok rows that have full data.
          const r = (c: Candidate): number => {
            if (c.view_count <= 0) return -1;
            const l = c.like_count;
            const cm = c.comment_count;
            const s = c.share_count;
            if (l === null && cm === null && s === null) return -0.5;
            return ((l ?? 0) + (cm ?? 0) + (s ?? 0)) / c.view_count;
          };
          return r(b) - r(a);
        }
      }
    });
    return copy;
  }, [candidates, sortKey]);

  // When candidates change, reset selection but preserve added/dup
  // markers from prior runs (shouldn't normally collide; the search
  // returns fresh post_ids each time).
  useEffect(() => {
    setSelected(new Set());
  }, [candidates]);

  function toggleSelected(id: string) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectableCandidates(): Candidate[] {
    return sortedCandidates.filter(
      (c) =>
        !c.already_in_library &&
        rowState[c.post_id] !== "added" &&
        rowState[c.post_id] !== "adding",
    );
  }

  function toggleSelectAll() {
    const usable = selectableCandidates();
    if (selected.size === usable.length && usable.length > 0) {
      setSelected(new Set());
    } else {
      setSelected(new Set(usable.map((c) => c.post_id)));
    }
  }

  async function runSearch() {
    setSearching(true);
    setSearchError(null);
    setRowError({});
    try {
      const res = await fetch(
        `/api/admin/titles/${titleSlug}/discover/search`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            platform,
            query: query.trim(),
            max_results: maxResults,
            // Period not exposed in UI; server defaults to 180d.
          }),
        },
      );
      const json = (await res.json().catch(() => ({}))) as SearchResponse;
      if (!res.ok || !json.ok) {
        setSearchError(json.error ?? `request failed (${res.status})`);
        return;
      }
      setCandidates(json.candidates);
      setRowState((s) => {
        const next: Record<string, RowState> = { ...s };
        for (const c of json.candidates) {
          if (c.already_in_library) next[c.post_id] = "duplicate";
          else if (!next[c.post_id]) next[c.post_id] = "new";
        }
        return next;
      });
      setLastSearch({
        at: new Date().toISOString(),
        count: json.results_count,
        units: json.units_estimated,
        warning: json.warning,
        debug: json.debug ?? null,
      });
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : String(err));
    } finally {
      setSearching(false);
    }
  }

  async function addCandidates(toAdd: Candidate[]) {
    if (toAdd.length === 0) return;
    setBulkBusy(true);
    setRowError({});
    setRowState((s) => {
      const next = { ...s };
      for (const c of toAdd) next[c.post_id] = "adding";
      return next;
    });
    try {
      const res = await fetch(
        `/api/admin/titles/${titleSlug}/discover/add`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ posts: toAdd }),
        },
      );
      const json = (await res.json().catch(() => ({}))) as AddResponse;
      if (!res.ok && !json.results) {
        setSearchError(json.error ?? `request failed (${res.status})`);
        setRowState((s) => {
          const next = { ...s };
          for (const c of toAdd) next[c.post_id] = "new";
          return next;
        });
        return;
      }
      setRowState((s) => {
        const next = { ...s };
        const byUrl = new Map(toAdd.map((c) => [c.post_url, c.post_id]));
        for (const r of json.results ?? []) {
          const id = byUrl.get(r.embed_url);
          if (!id) continue;
          if (r.outcome === "added") next[id] = "added";
          else if (r.outcome === "duplicate") next[id] = "duplicate";
          else next[id] = "failed";
        }
        return next;
      });
      setRowError((s) => {
        const next = { ...s };
        const byUrl = new Map(toAdd.map((c) => [c.post_url, c.post_id]));
        for (const r of json.results ?? []) {
          const id = byUrl.get(r.embed_url);
          if (id && r.outcome === "failed" && r.error) next[id] = r.error;
        }
        return next;
      });
      // Refresh the server-rendered Fan edits tab counter in the
      // header by re-rendering the page — cheap given the size.
      router.refresh();
      setSelected(new Set());
    } finally {
      setBulkBusy(false);
    }
  }

  async function addByUrl() {
    const trimmed = urlInput.trim();
    if (!trimmed) return;
    setUrlBusy(true);
    setUrlMessage(null);
    try {
      const res = await fetch(
        `/api/admin/titles/${titleSlug}/discover/add`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: trimmed }),
        },
      );
      const json = (await res.json().catch(() => ({}))) as AddResponse;
      if (!res.ok && !json.results) {
        setUrlMessage({
          kind: "error",
          text: json.error ?? `request failed (${res.status})`,
        });
        return;
      }
      const r = json.results?.[0];
      if (!r) {
        setUrlMessage({
          kind: "error",
          text: "No result returned for that URL.",
        });
        return;
      }
      if (r.outcome === "added") {
        setUrlMessage({ kind: "ok", text: `Added ${trimmed}.` });
        setUrlInput("");
        router.refresh();
      } else if (r.outcome === "duplicate") {
        setUrlMessage({
          kind: "error",
          text: "Already in this title's fan edits.",
        });
      } else {
        setUrlMessage({
          kind: "error",
          text: r.error ?? "Add failed.",
        });
      }
    } finally {
      setUrlBusy(false);
    }
  }

  const selectedCandidates = sortedCandidates.filter((c) =>
    selected.has(c.post_id),
  );
  const usableCount = selectableCandidates().length;
  const selectAllChecked = usableCount > 0 && selected.size === usableCount;

  return (
    <div className="flex flex-col gap-8">
      {/* SEARCH */}
      <section className="rounded-2xl border border-white/10 bg-white/[0.02] p-6">
        <div className="mb-4 flex items-center gap-3">
          <span className="rounded-full bg-moonbeem-pink/15 px-2.5 py-0.5 text-caption font-medium text-moonbeem-pink">
            Discover
          </span>
          <span className="text-caption text-moonbeem-ink-subtle">
            search EnsembleData for fan edits to attribute
          </span>
        </div>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-[120px_1fr_120px_auto]">
          <label className="flex flex-col gap-1 text-caption text-moonbeem-ink-subtle">
            Platform
            <select
              value={platform}
              onChange={(e) => {
                const v = e.target.value;
                if (v === "tiktok" || v === "youtube") setPlatform(v);
              }}
              className="rounded-md border border-white/10 bg-black/30 px-3 py-2 text-body-sm text-moonbeem-ink focus:border-moonbeem-pink focus:outline-none"
            >
              {PLATFORMS.map((p) => (
                <option
                  key={p.id}
                  value={p.id}
                  disabled={!p.enabled}
                  title={p.disabledReason}
                >
                  {p.label}
                  {p.enabled ? "" : " — coming soon"}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-caption text-moonbeem-ink-subtle">
            Query
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={
                platform === "youtube"
                  ? `${titleName} (hashtag — # optional)`
                  : titleName
              }
              className="rounded-md border border-white/10 bg-black/30 px-3 py-2 text-body-sm text-moonbeem-ink focus:border-moonbeem-pink focus:outline-none"
            />
          </label>
          <label className="flex flex-col gap-1 text-caption text-moonbeem-ink-subtle">
            Max results
            <select
              value={maxResults}
              onChange={(e) =>
                setMaxResults(Number(e.target.value) as 20 | 30 | 50)
              }
              className="rounded-md border border-white/10 bg-black/30 px-3 py-2 text-body-sm text-moonbeem-ink focus:border-moonbeem-pink focus:outline-none"
            >
              {MAX_RESULTS_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={runSearch}
            disabled={searching || query.trim().length === 0}
            className="self-end rounded-md bg-moonbeem-pink px-4 py-2 text-body-sm font-semibold text-moonbeem-navy hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {searching ? "Searching…" : "Search"}
          </button>
        </div>

        {lastSearch && (
          <>
            <p className="mt-3 text-caption text-moonbeem-ink-subtle">
              Last search {formatRelativeIso(lastSearch.at)} ·{" "}
              {lastSearch.count}{" "}
              {lastSearch.count === 1 ? "result" : "results"} ·{" "}
              ~{lastSearch.units}{" "}
              {lastSearch.units === 1 ? "unit" : "units"} estimated
              {lastSearch.warning ? ` · warning: ${lastSearch.warning}` : ""}
            </p>
            {lastSearch.debug && (
              <details className="mt-2">
                <summary className="cursor-pointer text-caption text-moonbeem-ink-muted hover:text-moonbeem-pink">
                  Show raw EnsembleData payload (truncated to 5KB)
                </summary>
                <pre className="mt-2 max-h-72 overflow-auto rounded-md border border-white/10 bg-black/40 p-3 font-mono text-caption text-moonbeem-ink-muted">
                  {lastSearch.debug.raw_payload_truncated}
                </pre>
              </details>
            )}
          </>
        )}
        {searchError && (
          <p className="mt-3 text-caption text-moonbeem-magenta">
            {searchError}
          </p>
        )}
      </section>

      {/* RESULTS */}
      {sortedCandidates.length > 0 && (
        <section className="rounded-2xl border border-white/10 bg-white/[0.02] p-6">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-2 text-caption text-moonbeem-ink-subtle">
                <input
                  type="checkbox"
                  checked={selectAllChecked}
                  onChange={toggleSelectAll}
                  disabled={usableCount === 0}
                  className="accent-moonbeem-pink"
                />
                Select all ({usableCount} selectable)
              </label>
              <button
                type="button"
                onClick={() => addCandidates(selectedCandidates)}
                disabled={bulkBusy || selectedCandidates.length === 0}
                className="rounded-md bg-moonbeem-pink px-3 py-1.5 text-caption font-semibold text-moonbeem-navy hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {bulkBusy
                  ? "Adding…"
                  : `Add selected (${selectedCandidates.length})`}
              </button>
            </div>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-2 text-caption text-moonbeem-ink-subtle">
                Sort
                <select
                  value={sortKey}
                  onChange={(e) => setSortKey(e.target.value as SortKey)}
                  className="rounded-md border border-white/10 bg-black/30 px-2 py-1 text-caption text-moonbeem-ink focus:border-moonbeem-pink focus:outline-none"
                >
                  <option value="views">Views desc</option>
                  <option value="posted_at">Posted at desc</option>
                  <option value="engagement">Engagement rate desc</option>
                </select>
              </label>
              <button
                type="button"
                onClick={runSearch}
                disabled={searching}
                className="rounded-md border border-white/15 px-3 py-1 text-caption text-moonbeem-ink-muted hover:border-moonbeem-pink hover:text-moonbeem-pink disabled:cursor-not-allowed disabled:opacity-40"
              >
                {searching ? "Refreshing…" : "Refresh search"}
              </button>
            </div>
          </div>

          <ul className="flex flex-col divide-y divide-white/5">
            {sortedCandidates.map((c) => {
              const state = rowState[c.post_id] ?? "new";
              const disabledRow =
                c.already_in_library ||
                state === "added" ||
                state === "adding";
              return (
                <li
                  key={c.post_id}
                  className={`flex flex-wrap items-start gap-4 py-4 ${
                    disabledRow ? "opacity-60" : ""
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(c.post_id)}
                    disabled={disabledRow}
                    onChange={() => toggleSelected(c.post_id)}
                    className="mt-2 accent-moonbeem-pink"
                  />
                  <div className="relative h-20 w-20 shrink-0 overflow-hidden rounded-md bg-moonbeem-navy/40">
                    {c.thumbnail_url ? (
                      <Image
                        src={c.thumbnail_url}
                        alt=""
                        fill
                        sizes="80px"
                        unoptimized
                        className="object-cover"
                      />
                    ) : null}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      {c.author_handle
                        ? (
                          <a
                            href={c.author_url ??
                              authorUrl(c.platform, c.author_handle)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-body-sm font-medium text-moonbeem-ink hover:text-moonbeem-pink"
                          >
                            {/* Display name only — TikTok @-handles are
                                URL-safe; YT puts display text here. */}
                            {c.platform === "tiktok"
                              ? `@${c.author_handle}`
                              : c.author_handle}
                          </a>
                        )
                        : (
                          <span className="text-body-sm font-medium text-moonbeem-ink-subtle">
                            (channel unattributed)
                          </span>
                        )}
                      {c.author_display_name && (
                        <span className="text-caption text-moonbeem-ink-subtle">
                          {c.author_display_name}
                        </span>
                      )}
                      <RowStatusPill state={state} />
                      <a
                        href={c.post_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-caption text-moonbeem-ink-subtle hover:text-moonbeem-pink"
                      >
                        View on {platformLabel(c.platform)} ↗
                      </a>
                    </div>
                    {c.caption && (
                      <p className="mt-1 line-clamp-2 text-caption text-moonbeem-ink-muted">
                        {c.caption}
                      </p>
                    )}
                    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-caption tabular-nums text-moonbeem-ink-subtle">
                      <span>{formatStat(c.view_count)} views</span>
                      <span>{formatStat(c.like_count)} likes</span>
                      <span>{formatStat(c.comment_count)} comments</span>
                      <span>{formatStat(c.share_count)} shares</span>
                      <span>{formatStat(c.save_count)} saves</span>
                      <span>{formatPostedAt(c)}</span>
                    </div>
                    {rowError[c.post_id] && (
                      <p className="mt-1 text-caption text-moonbeem-magenta">
                        {rowError[c.post_id]}
                      </p>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {/* ADD BY URL */}
      <section className="rounded-2xl border border-white/10 bg-white/[0.02] p-6">
        <div className="mb-4 flex items-center gap-3">
          <span className="rounded-full bg-moonbeem-violet/20 px-2.5 py-0.5 text-caption font-medium text-moonbeem-violet-soft">
            Add by URL
          </span>
          <span className="text-caption text-moonbeem-ink-subtle">
            paste a TikTok / Instagram / Twitter post URL — fetches metadata
            and adds it
          </span>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex min-w-0 flex-1 flex-col gap-1 text-caption text-moonbeem-ink-subtle">
            URL
            <input
              type="text"
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              placeholder="https://www.tiktok.com/@user/video/..."
              className="rounded-md border border-white/10 bg-black/30 px-3 py-2 text-body-sm text-moonbeem-ink focus:border-moonbeem-pink focus:outline-none"
            />
          </label>
          <button
            type="button"
            onClick={addByUrl}
            disabled={urlBusy || urlInput.trim().length === 0}
            className="rounded-md bg-moonbeem-pink px-4 py-2 text-body-sm font-semibold text-moonbeem-navy hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {urlBusy ? "Adding…" : "Add"}
          </button>
        </div>
        {urlMessage && (
          <p
            className={`mt-3 text-caption ${
              urlMessage.kind === "ok"
                ? "text-emerald-300"
                : "text-moonbeem-magenta"
            }`}
          >
            {urlMessage.text}
          </p>
        )}
      </section>
    </div>
  );
}

function RowStatusPill({ state }: { state: RowState }) {
  if (state === "added") {
    return (
      <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-caption font-medium text-emerald-300">
        Added ✓
      </span>
    );
  }
  if (state === "duplicate") {
    return (
      <span className="rounded-full bg-white/10 px-2 py-0.5 text-caption font-medium text-moonbeem-ink-muted">
        Already in library
      </span>
    );
  }
  if (state === "adding") {
    return (
      <span className="rounded-full bg-moonbeem-pink/15 px-2 py-0.5 text-caption font-medium text-moonbeem-pink">
        Adding…
      </span>
    );
  }
  if (state === "failed") {
    return (
      <span className="rounded-full bg-moonbeem-magenta/20 px-2 py-0.5 text-caption font-medium text-moonbeem-magenta">
        Failed
      </span>
    );
  }
  return (
    <span className="rounded-full bg-white/5 px-2 py-0.5 text-caption text-moonbeem-ink-subtle">
      New
    </span>
  );
}

function formatStat(n: number | null): string {
  if (n === null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

function platformLabel(p: CandidatePlatform): string {
  if (p === "tiktok") return "TikTok";
  if (p === "youtube") return "YouTube";
  return p;
}

function authorUrl(p: CandidatePlatform, handle: string): string {
  if (p === "tiktok") return `https://www.tiktok.com/@${handle}`;
  if (p === "youtube") return `https://www.youtube.com/@${handle}`;
  return "#";
}

function formatRelativeIso(iso: string): string {
  return relativeFromMs(new Date(iso).getTime());
}

function formatRelativeUnix(unixSeconds: number): string {
  if (!unixSeconds || unixSeconds <= 0) return "—";
  return relativeFromMs(unixSeconds * 1000);
}

// Per-row posted-at cell. Prefers the source's pre-formatted relative
// string (YouTube's "1 day ago") when posted_at is missing; falls back
// to the unix-derived relative ("4h ago") for sources with timestamps.
// Empty string when neither is available — cleaner than a stray "—".
function formatPostedAt(c: Candidate): string {
  if (c.posted_at && c.posted_at > 0) return formatRelativeUnix(c.posted_at);
  if (c.posted_relative) return c.posted_relative;
  return "";
}

function relativeFromMs(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 0) return new Date(ms).toLocaleString();
  const sec = Math.round(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return `${day}d ago`;
}
