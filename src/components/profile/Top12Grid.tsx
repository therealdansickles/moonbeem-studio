"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
} from "@dnd-kit/sortable";
import type { TopTitle } from "@/lib/queries/profiles";
import TitleCard from "@/components/TitleCard";
import SortableTitleSlot from "./SortableTitleSlot";
import AddToTop12Modal from "./AddToTop12Modal";

type Props = {
  topTitles: TopTitle[];
  isOwner: boolean;
};

const TOTAL_SLOTS = 12;

export default function Top12Grid({ topTitles, isOwner }: Props) {
  const router = useRouter();
  const [reorderMode, setReorderMode] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerPosition, setPickerPosition] = useState<number>(1);
  const [items, setItems] = useState<TopTitle[]>(topTitles);
  const [savingReorder, setSavingReorder] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  // Sync local state when server-fetched topTitles change.
  const remoteSig = useMemo(
    () => topTitles.map((t) => `${t.position}:${t.id}`).join(","),
    [topTitles],
  );
  const [lastSig, setLastSig] = useState(remoteSig);
  if (lastSig !== remoteSig && !reorderMode && !savingReorder) {
    setItems(topTitles);
    setLastSig(remoteSig);
  }

  const slots: (TopTitle | null)[] = Array.from({ length: TOTAL_SLOTS }, () => null);
  for (const t of items) {
    if (t.position >= 1 && t.position <= TOTAL_SLOTS) {
      slots[t.position - 1] = t;
    }
  }

  const firstEmptyPosition = (() => {
    for (let i = 0; i < TOTAL_SLOTS; i++) {
      if (!slots[i]) return i + 1;
    }
    return TOTAL_SLOTS;
  })();
  const hasEmpty = items.length < TOTAL_SLOTS;

  function openPickerForFirstEmpty() {
    setPickerPosition(firstEmptyPosition);
    setPickerOpen(true);
  }

  function openPickerForPosition(pos: number) {
    setPickerPosition(pos);
    setPickerOpen(true);
  }

  async function handleRemove(titleId: string, id: string) {
    if (removingId) return;
    setRemovingId(id);
    try {
      const res = await fetch("/api/profile/top-titles/remove", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title_id: titleId }),
      });
      if (!res.ok) throw new Error(`remove ${res.status}`);
      router.refresh();
    } catch (err) {
      console.error(err);
    } finally {
      setRemovingId(null);
    }
  }

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const ordered = items.slice().sort((a, b) => a.position - b.position);
    const oldIndex = ordered.findIndex((t) => t.id === active.id);
    const newIndex = ordered.findIndex((t) => t.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    const next = arrayMove(ordered, oldIndex, newIndex).map((t, idx) => ({
      ...t,
      position: idx + 1,
    }));
    setItems(next);
    setSavingReorder(true);
    try {
      const res = await fetch("/api/profile/top-titles/reorder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          positions: next.map((t) => ({
            title_id: t.title_id,
            position: t.position,
          })),
        }),
      });
      if (!res.ok) throw new Error(`reorder ${res.status}`);
      router.refresh();
    } catch (err) {
      console.error(err);
    } finally {
      setSavingReorder(false);
    }
  }

  // 3 cols × 4 rows on mobile, 6 cols × 2 rows on desktop. Profile
  // container is max-w-7xl (1280px) so at viewports ≥1280px each
  // cell renders ~195px wide — comfortably inside the 160-180px
  // target with poster artwork legible.
  const gridClass =
    "grid grid-cols-3 md:grid-cols-6 gap-2 md:gap-3";

  // View-only path (or owner not in reorder mode): plain grid, server-rendered TitleCards.
  if (!isOwner) {
    return (
      <div className={gridClass}>
        {slots.map((slot, i) => (
          <div key={i} className="aspect-[2/3] w-full">
            {slot ? (
              <TitleCard title={slot.title} />
            ) : (
              <div className="h-full w-full rounded-xl border border-dashed border-white/10 bg-white/[0.02]" />
            )}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        {hasEmpty && !reorderMode && (
          <button
            type="button"
            onClick={openPickerForFirstEmpty}
            className="rounded-md border border-white/15 bg-white/5 px-3 py-1.5 text-body-sm text-moonbeem-ink transition-colors hover:border-moonbeem-pink hover:text-moonbeem-pink"
          >
            + Add film
          </button>
        )}
        {items.length > 1 && (
          <button
            type="button"
            onClick={() => setReorderMode((v) => !v)}
            disabled={savingReorder}
            className={`rounded-md border px-3 py-1.5 text-body-sm transition-colors disabled:opacity-50 ${
              reorderMode
                ? "border-moonbeem-lime bg-moonbeem-lime/10 text-moonbeem-lime"
                : "border-white/15 bg-white/5 text-moonbeem-ink hover:border-moonbeem-pink hover:text-moonbeem-pink"
            }`}
          >
            {reorderMode ? "Done" : "Reorder"}
          </button>
        )}
      </div>

      {reorderMode ? (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={items.map((t) => t.id)}
            strategy={rectSortingStrategy}
          >
            <div className={gridClass}>
              {items
                .slice()
                .sort((a, b) => a.position - b.position)
                .map((t) => (
                  <SortableTitleSlot key={t.id} item={t} />
                ))}
            </div>
          </SortableContext>
        </DndContext>
      ) : (
        <div className={gridClass}>
          {slots.map((slot, i) => {
            const pos = i + 1;
            if (!slot) {
              return (
                <button
                  key={`empty-${pos}`}
                  type="button"
                  onClick={() => openPickerForPosition(pos)}
                  className="aspect-[2/3] w-full rounded-xl border border-dashed border-white/15 bg-white/[0.02] text-moonbeem-ink-subtle transition-colors hover:border-moonbeem-pink hover:text-moonbeem-pink"
                >
                  <span className="text-heading-md">+</span>
                </button>
              );
            }
            const isRemoving = removingId === slot.id;
            return (
              <div key={slot.id} className="group relative aspect-[2/3] w-full">
                <TitleCard title={slot.title} />
                <button
                  type="button"
                  onClick={() => handleRemove(slot.title_id, slot.id)}
                  disabled={isRemoving}
                  aria-label={`Remove ${slot.title.title} from Top 12`}
                  className="absolute right-1.5 top-1.5 z-10 hidden h-6 w-6 items-center justify-center rounded-full bg-black/70 text-body-sm text-moonbeem-ink opacity-90 backdrop-blur-sm transition-colors hover:bg-moonbeem-magenta group-hover:flex disabled:opacity-50"
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
      )}

      {pickerOpen && (
        <AddToTop12Modal
          position={pickerPosition}
          existingTitleIds={items.map((t) => t.title_id)}
          onClose={() => setPickerOpen(false)}
          onAdded={() => {
            setPickerOpen(false);
            router.refresh();
          }}
        />
      )}
    </div>
  );
}
