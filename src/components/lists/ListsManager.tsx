"use client";

// Phase 1D — /me/lists index manager: create a list, rename/delete each list
// (ConfirmModal). The watchlist row shows count + link only (no rename/delete).

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import ConfirmModal from "@/components/ui/ConfirmModal";
import type { MyListSummary } from "@/lib/queries/lists";

function ListManagerRow({ list }: { list: MyListSummary }) {
  const router = useRouter();
  const isWatchlist = list.kind === "watchlist";
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(list.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  async function rename() {
    const n = name.trim();
    if (!n) {
      setError("Name required.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/me/lists", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: list.id, name: n }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setError(j.error ?? "Couldn't rename.");
        setBusy(false);
        return;
      }
      setEditing(false);
      router.refresh();
    } catch {
      setError("Couldn't rename.");
      setBusy(false);
    }
  }

  async function del() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/me/lists", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: list.id }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setError(j.error ?? "Couldn't delete.");
        setBusy(false);
        setConfirmOpen(false);
        return;
      }
      setConfirmOpen(false);
      router.refresh();
    } catch {
      setError("Couldn't delete.");
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.02] p-3">
      <div className="min-w-0 flex-1">
        {editing ? (
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={name}
              maxLength={100}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") rename();
              }}
              className="min-w-0 flex-1 rounded-md border border-moonbeem-border-strong bg-transparent px-3 py-1.5 text-body-sm text-moonbeem-ink focus:border-moonbeem-pink focus:outline-none"
            />
            <button
              type="button"
              onClick={rename}
              disabled={busy}
              className="text-caption font-semibold text-moonbeem-pink disabled:opacity-50"
            >
              Save
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setName(list.name);
                setError(null);
              }}
              className="text-caption text-moonbeem-ink-subtle hover:text-moonbeem-ink"
            >
              Cancel
            </button>
          </div>
        ) : (
          <Link
            href={`/me/lists/${list.id}`}
            className="truncate text-body-sm font-medium text-moonbeem-ink hover:text-moonbeem-pink"
          >
            {list.name}
            {isWatchlist && (
              <span className="ml-2 text-caption text-moonbeem-ink-subtle">
                watchlist
              </span>
            )}
          </Link>
        )}
        <div className="text-caption text-moonbeem-ink-subtle">
          {list.item_count} {list.item_count === 1 ? "film" : "films"}
        </div>
        {error && (
          <p className="m-0 text-caption text-moonbeem-magenta">{error}</p>
        )}
      </div>

      {!editing && (
        <div className="flex shrink-0 items-center gap-3">
          <Link
            href={`/me/lists/${list.id}`}
            className="text-caption text-moonbeem-pink hover:opacity-90"
          >
            {isWatchlist ? "View →" : "Edit films →"}
          </Link>
          {!isWatchlist && (
            <>
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="text-caption text-moonbeem-ink-subtle hover:text-moonbeem-pink"
              >
                Rename
              </button>
              <button
                type="button"
                onClick={() => setConfirmOpen(true)}
                className="text-caption text-moonbeem-ink-subtle hover:text-moonbeem-magenta"
              >
                Delete
              </button>
            </>
          )}
        </div>
      )}

      <ConfirmModal
        isOpen={confirmOpen}
        title="Delete this list?"
        description={`"${list.name}" and its ${list.item_count} item(s) will be removed.`}
        confirmLabel="Delete list"
        tone="destructive"
        busy={busy}
        onConfirm={del}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}

export default function ListsManager({ lists }: { lists: MyListSummary[] }) {
  const router = useRouter();
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function createList() {
    const name = newName.trim();
    if (!name || creating) return;
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/me/lists", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setError(j.error ?? "Couldn't create list.");
        setCreating(false);
        return;
      }
      setNewName("");
      router.refresh();
    } catch {
      setError("Couldn't create list.");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={newName}
          maxLength={100}
          placeholder="New list name…"
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") createList();
          }}
          className="min-w-0 flex-1 rounded-md border border-moonbeem-border-strong bg-transparent px-4 py-2.5 text-body-sm text-moonbeem-ink placeholder:text-moonbeem-ink-subtle focus:border-moonbeem-pink focus:outline-none"
        />
        <button
          type="button"
          onClick={createList}
          disabled={!newName.trim() || creating}
          className="rounded-md bg-moonbeem-pink px-4 py-2.5 text-body-sm font-semibold text-moonbeem-navy transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {creating ? "Creating…" : "Create list"}
        </button>
      </div>
      {error && <p className="m-0 text-body-sm text-moonbeem-magenta">{error}</p>}

      {lists.length === 0 ? (
        <p className="text-body-sm text-moonbeem-ink-subtle">No lists yet.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {lists.map((l) => (
            <li key={l.id}>
              <ListManagerRow list={l} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
