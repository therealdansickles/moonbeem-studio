"use client";

// Debounced catalog type-ahead for the Review Queue "correct the title" flow.
// Clones AttachTitleModal's search against GET /api/admin/titles/search
// (search_titles_admin → GIN idx_titles_title_trgm; NEVER an is_public filter, which
// would seq-scan the 1.45M-row catalog). Each result shows title + year so remakes
// and homonyms are distinguishable — that IS the correction case.

import { useEffect, useRef, useState } from "react";

export type TitleHit = {
  id: string;
  slug: string;
  title: string;
  year: number | null;
  is_public?: boolean;
};

const DEBOUNCE_MS = 300;
const MIN_LEN = 2;

export default function TitlePicker({
  onPick,
  onCancel,
  busy,
}: {
  onPick: (hit: TitleHit) => void;
  onCancel: () => void;
  busy?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<TitleHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const q = query.trim();
    if (q.length < MIN_LEN) {
      setHits([]);
      setSearching(false);
      setErr(null);
      return;
    }
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/admin/titles/search?q=${encodeURIComponent(q)}&limit=10`,
        );
        const j = await res.json();
        if (!res.ok) {
          setErr(j.error ?? `search ${res.status}`);
          setHits([]);
        } else {
          setErr(null);
          setHits(j.results ?? []);
        }
      } catch (e) {
        setErr(String(e));
        setHits([]);
      } finally {
        setSearching(false);
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query]);

  return (
    <div className="mt-1 flex flex-col gap-2 rounded-md border border-white/10 bg-white/[0.03] p-3">
      <div className="flex items-center gap-2">
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search the catalog for the right title"
          className="flex-1 rounded-md border border-white/15 bg-white/5 px-3 py-1.5 text-body-sm text-moonbeem-ink placeholder:text-moonbeem-ink-subtle"
        />
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-white/15 px-3 py-1.5 text-body-sm text-moonbeem-ink-muted hover:border-moonbeem-pink hover:text-moonbeem-pink"
        >
          Cancel
        </button>
      </div>
      {searching && (
        <p className="m-0 text-caption text-moonbeem-ink-subtle">Searching…</p>
      )}
      {err && <p className="m-0 text-caption text-moonbeem-magenta">{err}</p>}
      {hits.length > 0 && (
        <ul className="flex max-h-60 flex-col divide-y divide-white/5 overflow-y-auto">
          {hits.map((h) => (
            <li key={h.id}>
              <button
                type="button"
                disabled={busy}
                onClick={() => onPick(h)}
                className="flex w-full items-center justify-between gap-3 px-2 py-1.5 text-left text-body-sm text-moonbeem-ink hover:bg-white/5 disabled:opacity-40"
              >
                <span className="truncate">{h.title}</span>
                <span className="shrink-0 text-caption text-moonbeem-ink-subtle">
                  {h.year ?? "—"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {query.trim().length >= MIN_LEN && !searching && hits.length === 0 && !err && (
        <p className="m-0 text-caption text-moonbeem-ink-subtle">No titles found.</p>
      )}
    </div>
  );
}
