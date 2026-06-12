"use client";

// Phase 1D — /me/lists/[id] builder. AddToTop12Modal-style debounced search-add
// + per-row remove. Items are kept in optimistic client state (the server
// persists each add/remove); no reorder.

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { SearchResult } from "@/lib/queries/titles";
import type { ListItem } from "@/lib/queries/lists";

const DEBOUNCE_MS = 300;
const MIN_QUERY_LEN = 2;

export default function ListBuilder({
  listId,
  initialItems,
  initialDescription,
  canEditMeta,
}: {
  listId: string;
  initialItems: ListItem[];
  // Description editing is for kind='list' only; the watchlist passes
  // canEditMeta=false and stays add/remove-only (no rename/description).
  initialDescription: string | null;
  canEditMeta: boolean;
}) {
  const [items, setItems] = useState<ListItem[]>(initialItems);
  const [description, setDescription] = useState(initialDescription ?? "");
  const [savedDescription, setSavedDescription] = useState(
    initialDescription ?? "",
  );
  const [descBusy, setDescBusy] = useState(false);
  const [descStatus, setDescStatus] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const t = query.trim();
    if (t.length < MIN_QUERY_LEN) {
      setResults([]);
      setLoading(false);
      abortRef.current?.abort();
      return;
    }
    setLoading(true);
    const timer = setTimeout(async () => {
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(t)}`, {
          signal: ac.signal,
        });
        if (!res.ok) throw new Error(`search ${res.status}`);
        const json = (await res.json()) as { results: SearchResult[] };
        if (!ac.signal.aborted) setResults(json.results);
      } catch (err) {
        if ((err as Error).name !== "AbortError") setResults([]);
      } finally {
        if (!ac.signal.aborted) setLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const present = new Set(
    items.map((i) => i.title_id).filter((x): x is string => Boolean(x)),
  );

  async function add(r: SearchResult) {
    if (busy || present.has(r.id)) return;
    setBusy(r.id);
    setError(null);
    try {
      const res = await fetch("/api/me/lists/items", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ list_id: listId, title_id: r.id }),
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(j.error ?? "Couldn't add.");
        setBusy(null);
        return;
      }
      setItems((prev) =>
        prev.some((i) => i.title_id === r.id)
          ? prev
          : [
              ...prev,
              {
                id: `new-${r.id}`,
                title_id: r.id,
                title_slug: null, // server provides the slug on next load
                title_name: r.title,
                poster_url: r.poster_url ?? null,
                position: prev.length + 1,
              },
            ],
      );
    } catch {
      setError("Couldn't add.");
    } finally {
      setBusy(null);
    }
  }

  async function remove(item: ListItem) {
    if (!item.title_id || busy) return;
    setBusy(item.id);
    setError(null);
    const prev = items;
    setItems(items.filter((i) => i.id !== item.id)); // optimistic
    try {
      const res = await fetch("/api/me/lists/items", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ list_id: listId, title_id: item.title_id }),
      });
      if (!res.ok) {
        setItems(prev);
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setError(j.error ?? "Couldn't remove.");
      }
    } catch {
      setItems(prev);
      setError("Couldn't remove.");
    } finally {
      setBusy(null);
    }
  }

  async function saveDescription() {
    if (descBusy) return;
    setDescBusy(true);
    setDescStatus(null);
    try {
      const res = await fetch("/api/me/lists", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: listId, description }),
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setDescStatus(j.error ?? "Couldn't save.");
      } else {
        setSavedDescription(description);
        setDescStatus("Saved");
      }
    } catch {
      setDescStatus("Couldn't save.");
    } finally {
      setDescBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {canEditMeta && (
        <div className="flex flex-col gap-2">
          <label
            htmlFor="list-description"
            className="text-body-sm font-medium text-moonbeem-ink-muted"
          >
            Description
          </label>
          <textarea
            id="list-description"
            value={description}
            maxLength={2000}
            rows={3}
            placeholder="Add a description for this list…"
            onChange={(e) => {
              setDescription(e.target.value);
              setDescStatus(null);
            }}
            className="w-full resize-y rounded-md border border-moonbeem-border-strong bg-transparent px-4 py-3 text-body-sm text-moonbeem-ink placeholder:text-moonbeem-ink-subtle focus:border-moonbeem-pink focus:outline-none"
          />
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={saveDescription}
              disabled={descBusy || description === savedDescription}
              className="rounded-md bg-moonbeem-pink px-4 py-1.5 text-body-sm font-semibold text-moonbeem-navy transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {descBusy ? "Saving…" : "Save description"}
            </button>
            {descStatus && (
              <span className="text-caption text-moonbeem-ink-subtle">
                {descStatus}
              </span>
            )}
          </div>
        </div>
      )}

      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search for a film to add…"
        className="w-full rounded-md border border-moonbeem-border-strong bg-transparent px-4 py-3 text-body text-moonbeem-ink placeholder:text-moonbeem-ink-subtle focus:border-moonbeem-pink focus:outline-none"
      />

      {error && <p className="m-0 text-body-sm text-moonbeem-magenta">{error}</p>}

      {query.trim().length >= MIN_QUERY_LEN && (
        <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
          {loading ? (
            <p className="py-4 text-center text-body-sm text-moonbeem-ink-subtle">
              Searching…
            </p>
          ) : results.length === 0 ? (
            <p className="py-4 text-center text-body-sm text-moonbeem-ink-subtle">
              No matches.
            </p>
          ) : (
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {results.map((r) => {
                const already = present.has(r.id);
                return (
                  <li key={r.id}>
                    <button
                      type="button"
                      onClick={() => add(r)}
                      disabled={already || busy === r.id}
                      className="group flex w-full flex-col gap-2 rounded-lg border border-white/5 bg-white/[0.03] p-2 text-left transition-colors hover:border-moonbeem-pink disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <div className="relative aspect-[2/3] w-full overflow-hidden rounded-md bg-moonbeem-navy/40">
                        {r.poster_url ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={r.poster_url}
                            alt=""
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <div className="absolute inset-0 flex items-center justify-center p-2 text-center text-body-sm text-moonbeem-ink-subtle">
                            {r.title}
                          </div>
                        )}
                      </div>
                      <p className="line-clamp-2 text-body-sm text-moonbeem-ink">
                        {r.title}
                        {r.year ? (
                          <span className="text-moonbeem-ink-subtle"> ({r.year})</span>
                        ) : null}
                      </p>
                      {already && (
                        <span className="text-caption text-moonbeem-ink-subtle">
                          Already in list
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      <div>
        <h2 className="m-0 text-body font-medium text-moonbeem-ink-muted">
          In this list ({items.length})
        </h2>
        <div className="mt-3 flex flex-col gap-2 border-t border-white/10 pt-3">
          {items.length === 0 ? (
            <p className="m-0 text-body-sm text-moonbeem-ink-subtle">
              No films yet — search above to add some.
            </p>
          ) : (
            items.map((item) => (
              <div
                key={item.id}
                className="flex items-center gap-3 rounded-lg border border-white/10 bg-white/[0.02] p-2"
              >
                <div className="relative h-[60px] w-[40px] shrink-0 overflow-hidden rounded-md bg-moonbeem-navy/40">
                  {item.poster_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={item.poster_url}
                      alt=""
                      className="h-full w-full object-cover"
                    />
                  ) : null}
                </div>
                <div className="min-w-0 flex-1">
                  {item.title_slug ? (
                    <Link
                      href={`/t/${item.title_slug}`}
                      className="truncate text-body-sm text-moonbeem-ink hover:text-moonbeem-pink"
                    >
                      {item.title_name}
                    </Link>
                  ) : (
                    <span className="truncate text-body-sm text-moonbeem-ink">
                      {item.title_name}
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => remove(item)}
                  disabled={busy === item.id}
                  className="shrink-0 text-caption text-moonbeem-ink-subtle transition-colors hover:text-moonbeem-magenta disabled:opacity-50"
                >
                  Remove
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
