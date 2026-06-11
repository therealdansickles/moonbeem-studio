"use client";

// Phase 1D — add-to-list picker (AddToTop12Modal z-50 precedent). Loads the
// caller's lists (watchlist included) with a per-row checkmark when the title
// is already on that list; a row click toggles membership via the items /
// watchlist routes. Inline "New list" create at the bottom. On close, if
// anything changed, refresh the page (keeps the header watchlist toggle in
// sync — it's keyed on the server state).

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type PickerList = {
  id: string;
  name: string;
  kind: string;
  item_count: number;
  contains: boolean;
};

export default function ListPickerModal({
  titleId,
  titleName,
  onClose,
}: {
  titleId: string;
  titleName: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [lists, setLists] = useState<PickerList[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [opError, setOpError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const changedRef = useRef(false);

  function close() {
    if (changedRef.current) router.refresh();
    onClose();
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(
          `/api/me/lists?title_id=${encodeURIComponent(titleId)}`,
        );
        if (!res.ok) {
          setLoadError("Couldn't load your lists.");
          setLists([]);
          return;
        }
        const j = (await res.json()) as { lists?: PickerList[] };
        setLists(j.lists ?? []);
      } catch {
        setLoadError("Couldn't load your lists.");
        setLists([]);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function patchLocal(id: string, contains: boolean) {
    setLists(
      (prev) =>
        prev?.map((l) =>
          l.id === id
            ? {
                ...l,
                contains,
                item_count: Math.max(0, l.item_count + (contains ? 1 : -1)),
              }
            : l,
        ) ?? null,
    );
  }

  async function toggle(list: PickerList) {
    if (busyId) return;
    setBusyId(list.id);
    setOpError(null);
    const adding = !list.contains;
    const isWatchlist = list.kind === "watchlist";
    const url = isWatchlist ? "/api/me/watchlist" : "/api/me/lists/items";
    const body = isWatchlist
      ? { title_id: titleId }
      : { list_id: list.id, title_id: titleId };
    patchLocal(list.id, adding); // optimistic
    try {
      const res = await fetch(url, {
        method: adding ? "POST" : "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        patchLocal(list.id, !adding);
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setOpError(j.error ?? "Couldn't update that list.");
      } else {
        changedRef.current = true;
      }
    } catch {
      patchLocal(list.id, !adding);
      setOpError("Couldn't update that list.");
    } finally {
      setBusyId(null);
    }
  }

  async function createList() {
    const name = newName.trim();
    if (!name || creating) return;
    setCreating(true);
    setOpError(null);
    try {
      const res = await fetch("/api/me/lists", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const j = (await res.json().catch(() => ({}))) as {
        error?: string;
        id?: string;
      };
      if (!res.ok || !j.id) {
        setOpError(j.error ?? "Couldn't create that list.");
        setCreating(false);
        return;
      }
      // Add the title to the new list so it appears checked.
      const addRes = await fetch("/api/me/lists/items", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ list_id: j.id, title_id: titleId }),
      });
      const added = addRes.ok;
      changedRef.current = true;
      setNewName("");
      setLists((prev) => [
        ...(prev ?? []),
        {
          id: j.id as string,
          name,
          kind: "list",
          item_count: added ? 1 : 0,
          contains: added,
        },
      ]);
      if (!added) {
        setOpError("List created, but adding the film failed — tap it to add.");
      }
    } catch {
      setOpError("Couldn't create that list.");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Add ${titleName} to a list`}
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/70 px-4 pt-20 backdrop-blur-sm"
      onClick={close}
    >
      <div
        className="w-full max-w-md rounded-2xl border border-white/10 bg-moonbeem-black/95 p-6 shadow-2xl shadow-black/60"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3">
          <h2 className="m-0 font-wordmark text-heading-md text-moonbeem-ink">
            Add to list
          </h2>
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className="rounded-md px-2 py-1 text-body-sm text-moonbeem-ink-subtle hover:text-moonbeem-ink"
          >
            ✕
          </button>
        </div>
        <p className="mt-1 text-body-sm text-moonbeem-ink-subtle">{titleName}</p>

        <div className="mt-4 max-h-[45vh] overflow-y-auto">
          {lists === null ? (
            <p className="py-6 text-center text-body-sm text-moonbeem-ink-subtle">
              Loading…
            </p>
          ) : loadError ? (
            <p className="py-6 text-center text-body-sm text-moonbeem-magenta">
              {loadError}
            </p>
          ) : lists.length === 0 ? (
            <p className="py-6 text-center text-body-sm text-moonbeem-ink-subtle">
              You don&apos;t have any lists yet — create one below.
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {lists.map((l) => (
                <li key={l.id}>
                  <button
                    type="button"
                    onClick={() => toggle(l)}
                    disabled={busyId === l.id}
                    aria-pressed={l.contains}
                    className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left transition-colors hover:bg-white/5 disabled:opacity-50"
                  >
                    <span
                      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border text-caption ${
                        l.contains
                          ? "border-moonbeem-pink bg-moonbeem-pink text-moonbeem-navy"
                          : "border-white/20 text-transparent"
                      }`}
                      aria-hidden
                    >
                      ✓
                    </span>
                    <span className="min-w-0 flex-1 truncate text-body-sm text-moonbeem-ink">
                      {l.name}
                      {l.kind === "watchlist" && (
                        <span className="ml-2 text-caption text-moonbeem-ink-subtle">
                          watchlist
                        </span>
                      )}
                    </span>
                    <span className="text-caption text-moonbeem-ink-subtle">
                      {l.item_count}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {opError && (
          <p className="mt-2 text-body-sm text-moonbeem-magenta">{opError}</p>
        )}

        <div className="mt-4 flex items-center gap-2 border-t border-white/10 pt-4">
          <input
            type="text"
            value={newName}
            maxLength={100}
            placeholder="New list name…"
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") createList();
            }}
            className="min-w-0 flex-1 rounded-md border border-moonbeem-border-strong bg-transparent px-3 py-2 text-body-sm text-moonbeem-ink placeholder:text-moonbeem-ink-subtle focus:border-moonbeem-pink focus:outline-none"
          />
          <button
            type="button"
            onClick={createList}
            disabled={!newName.trim() || creating}
            className="rounded-md bg-moonbeem-pink px-4 py-2 text-body-sm font-semibold text-moonbeem-navy transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {creating ? "Creating…" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}
