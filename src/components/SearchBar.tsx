"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { SearchResult } from "@/lib/queries/titles";

const DEBOUNCE_MS = 300;
const MIN_QUERY_LEN = 2;

export default function SearchBar() {
  const router = useRouter();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  // Debounced fetch
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < MIN_QUERY_LEN) {
      setResults([]);
      setLoading(false);
      abortRef.current?.abort();
      return;
    }

    setLoading(true);
    const handle = setTimeout(async () => {
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
        setResults(json.results);
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          setResults([]);
        }
      } finally {
        if (!ac.signal.aborted) setLoading(false);
      }
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(handle);
    };
  }, [query]);

  // Click outside closes
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      setOpen(false);
      inputRef.current?.blur();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const trimmed = query.trim();
      if (trimmed.length >= MIN_QUERY_LEN) {
        setOpen(false);
        router.push(`/search?q=${encodeURIComponent(trimmed)}`);
      }
    }
  }

  function navigateTo(slug: string) {
    setOpen(false);
    setQuery("");
    setResults([]);
    router.push(`/t/${slug}`);
  }

  const trimmed = query.trim();
  const showDropdown = open && (trimmed.length >= MIN_QUERY_LEN || trimmed === "");

  return (
    <div ref={containerRef} className="relative w-full max-w-[480px]">
      <input
        ref={inputRef}
        type="search"
        autoComplete="off"
        spellCheck={false}
        value={query}
        placeholder="Search films..."
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        className="w-full rounded-xl bg-black/40 border border-white/10 px-4 py-2 text-body-sm text-moonbeem-ink placeholder:text-moonbeem-ink-subtle focus:outline-none focus:border-moonbeem-pink transition-colors"
      />

      {showDropdown && (
        <div className="absolute left-0 right-0 top-full mt-2 rounded-xl bg-moonbeem-black/95 backdrop-blur-md border border-white/10 shadow-2xl shadow-black/50 max-h-[480px] overflow-y-auto z-30">
          {trimmed.length < MIN_QUERY_LEN && !loading && (
            <p className="px-4 py-6 text-body-sm text-moonbeem-ink-muted text-center">
              Type to search 86,000+ films
            </p>
          )}

          {loading && (
            <ul className="py-2">
              {[0, 1, 2].map((i) => (
                <li
                  key={i}
                  className="flex items-center gap-3 px-3 py-2 animate-pulse"
                >
                  <div className="h-[60px] w-[40px] rounded-md bg-white/5 shrink-0" />
                  <div className="flex-1 space-y-2">
                    <div className="h-3 w-3/4 rounded bg-white/5" />
                    <div className="h-2 w-1/3 rounded bg-white/5" />
                  </div>
                </li>
              ))}
            </ul>
          )}

          {!loading && trimmed.length >= MIN_QUERY_LEN && results.length === 0 && (
            <p className="px-4 py-6 text-body-sm text-moonbeem-ink-muted text-center">
              No films match &lsquo;{trimmed}&rsquo;.
            </p>
          )}

          {!loading && results.length > 0 && (
            <ul role="listbox" className="py-1">
              {results.map((r) => {
                const featured = r.is_featured && r.is_active;
                return (
                  <li key={r.id} role="option">
                    <button
                      type="button"
                      onClick={() => navigateTo(r.slug)}
                      className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-white/5 transition-colors"
                    >
                      <div className="relative h-[60px] w-[40px] shrink-0 rounded-md overflow-hidden bg-moonbeem-navy/40">
                        {r.poster_url ? (
                          <Image
                            src={r.poster_url}
                            alt=""
                            fill
                            sizes="40px"
                            className="object-cover"
                          />
                        ) : null}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-body-sm font-medium text-moonbeem-ink truncate flex items-center gap-1.5">
                          {featured && (
                            <span
                              aria-label="Featured"
                              className="inline-block h-1.5 w-1.5 rounded-full bg-moonbeem-lime shrink-0"
                            />
                          )}
                          <span className="truncate">{r.title}</span>
                        </p>
                        <p className="text-caption text-moonbeem-ink-subtle truncate">
                          {[r.year ?? null, r.distributor ?? null]
                            .filter(Boolean)
                            .join(" · ") || "—"}
                        </p>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {!loading && trimmed.length >= MIN_QUERY_LEN && (
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                router.push(`/search?q=${encodeURIComponent(trimmed)}`);
              }}
              className="block w-full border-t border-white/5 px-4 py-3 text-left text-body-sm text-moonbeem-pink hover:bg-white/5 transition-colors"
            >
              See all results for &lsquo;{trimmed}&rsquo; →
            </button>
          )}
        </div>
      )}
    </div>
  );
}
