"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import type { SearchResult } from "@/lib/queries/titles";

type Props = {
  position: number;
  existingTitleIds: string[];
  onClose: () => void;
  onAdded: () => void;
};

const DEBOUNCE_MS = 300;
const MIN_QUERY_LEN = 2;

export default function AddToTop12Modal({
  position,
  existingTitleIds,
  onClose,
  onAdded,
}: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < MIN_QUERY_LEN) {
      setResults([]);
      setLoading(false);
      abortRef.current?.abort();
      return;
    }
    setLoading(true);
    const t = setTimeout(async () => {
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      try {
        const res = await fetch(
          `/api/search?q=${encodeURIComponent(trimmed)}`,
          { signal: ac.signal },
        );
        if (!res.ok) throw new Error(`search ${res.status}`);
        const json = (await res.json()) as { results: SearchResult[] };
        if (!ac.signal.aborted) setResults(json.results);
      } catch (err) {
        if ((err as Error).name !== "AbortError") setResults([]);
      } finally {
        if (!ac.signal.aborted) setLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query]);

  async function add(titleId: string) {
    if (adding) return;
    setAdding(titleId);
    setErrorMsg("");
    try {
      const res = await fetch("/api/profile/top-titles/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title_id: titleId, position }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setErrorMsg(json.error ?? `add ${res.status}`);
        setAdding(null);
        return;
      }
      onAdded();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setAdding(null);
    }
  }

  const trimmed = query.trim();
  const showEmpty = trimmed.length < MIN_QUERY_LEN;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Add a film to your Top 12"
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/70 px-4 pt-20 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl rounded-2xl border border-white/10 bg-moonbeem-black/95 p-6 shadow-2xl shadow-black/60"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-wordmark text-heading-md text-moonbeem-ink m-0">
            Add to your Top 12
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md px-2 py-1 text-body-sm text-moonbeem-ink-subtle hover:text-moonbeem-ink"
          >
            ✕
          </button>
        </div>

        <input
          ref={inputRef}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search for a film..."
          className="mt-4 w-full rounded-md border border-moonbeem-border-strong bg-transparent px-4 py-3 text-body text-moonbeem-ink placeholder:text-moonbeem-ink-subtle focus:border-moonbeem-pink focus:outline-none"
        />

        {errorMsg && (
          <p className="mt-3 text-body-sm text-moonbeem-magenta">{errorMsg}</p>
        )}

        <div className="mt-4 max-h-[55vh] overflow-y-auto">
          {showEmpty ? (
            <p className="py-12 text-center text-body-sm text-moonbeem-ink-subtle">
              Search for a film to add.
            </p>
          ) : loading ? (
            <p className="py-12 text-center text-body-sm text-moonbeem-ink-subtle">
              Searching...
            </p>
          ) : results.length === 0 ? (
            <p className="py-12 text-center text-body-sm text-moonbeem-ink-subtle">
              No matches.
            </p>
          ) : (
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {results.map((r) => {
                const already = existingTitleIds.includes(r.id);
                const isAdding = adding === r.id;
                return (
                  <li key={r.id}>
                    <button
                      type="button"
                      disabled={already || isAdding}
                      onClick={() => add(r.id)}
                      className="group flex w-full flex-col gap-2 rounded-lg border border-white/5 bg-white/[0.03] p-2 text-left transition-colors hover:border-moonbeem-pink disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-white/5"
                    >
                      <div className="relative aspect-[2/3] w-full overflow-hidden rounded-md bg-moonbeem-navy/40">
                        {r.poster_url ? (
                          <Image
                            src={r.poster_url}
                            alt=""
                            fill
                            sizes="200px"
                            className="object-cover"
                          />
                        ) : (
                          <div className="absolute inset-0 flex items-center justify-center p-3 text-center text-body-sm text-moonbeem-ink-subtle">
                            {r.title}
                          </div>
                        )}
                      </div>
                      <p className="text-body-sm text-moonbeem-ink line-clamp-2">
                        {r.title}
                        {r.year ? (
                          <span className="text-moonbeem-ink-subtle">
                            {" "}
                            ({r.year})
                          </span>
                        ) : null}
                      </p>
                      {already && (
                        <span className="text-caption text-moonbeem-ink-subtle">
                          Already in Top 12
                        </span>
                      )}
                      {isAdding && (
                        <span className="text-caption text-moonbeem-pink">
                          Adding...
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
