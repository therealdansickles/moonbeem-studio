"use client";

// Phase 1C — a diary row on /me/diary with an owner delete control
// (ConfirmModal → DELETE /api/me/diary → router.refresh). Wraps the
// presentational DiaryRow.

import { useState } from "react";
import { useRouter } from "next/navigation";
import ConfirmModal from "@/components/ui/ConfirmModal";
import DiaryRow from "@/components/diary/DiaryRow";
import type { DiaryEntry } from "@/lib/queries/diary";

export default function DiaryManageRow({ entry }: { entry: DiaryEntry }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleted, setDeleted] = useState(false);

  async function doDelete() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/me/diary", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: entry.id }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setError(j.error ?? "Couldn't delete.");
        setBusy(false);
        return;
      }
      setDeleted(true);
      setOpen(false);
      router.refresh();
    } catch {
      setError("Couldn't delete.");
      setBusy(false);
    }
  }

  if (deleted) return null;

  return (
    <DiaryRow
      entry={entry}
      action={
        <div className="flex shrink-0 flex-col items-end gap-1">
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="text-caption text-moonbeem-ink-subtle transition-colors hover:text-moonbeem-magenta"
          >
            Delete
          </button>
          {error && (
            <span className="text-caption text-moonbeem-magenta">{error}</span>
          )}
          <ConfirmModal
            isOpen={open}
            title="Delete this diary entry?"
            description="This permanently removes the entry."
            detail={
              entry.rating != null
                ? "Your star rating for this title is kept."
                : undefined
            }
            confirmLabel="Delete"
            tone="destructive"
            busy={busy}
            onConfirm={doDelete}
            onCancel={() => setOpen(false)}
          />
        </div>
      }
    />
  );
}
