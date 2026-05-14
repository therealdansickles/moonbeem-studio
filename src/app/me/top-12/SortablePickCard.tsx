"use client";

// One row in the Top 12 picks panel. Draggable for reorder.
//
// dnd-kit listeners live ONLY on the grip handle, not the whole card
// — so on touch devices the card body still scrolls the page and a
// drag only starts from the handle. `touch-none` on the handle tells
// the browser to hand touch events to the PointerSensor instead of
// treating them as scroll.

import Image from "next/image";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { BuilderPick } from "./Top12Builder";

export default function SortablePickCard({
  pick,
  disabled,
  onRemove,
}: {
  pick: BuilderPick;
  disabled: boolean;
  onRemove: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: pick.title_id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 30 : undefined,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`flex items-center gap-2 rounded-lg border bg-white/[0.03] p-2 ${
        isDragging
          ? "border-moonbeem-pink shadow-[0_12px_28px_rgba(245,197,225,0.3)]"
          : "border-white/10"
      }`}
    >
      <button
        type="button"
        aria-label={`Reorder ${pick.title}`}
        className="shrink-0 cursor-grab touch-none px-1 text-body-sm text-moonbeem-ink-subtle hover:text-moonbeem-ink active:cursor-grabbing"
        {...attributes}
        {...listeners}
      >
        ⠿
      </button>

      <div className="relative h-[60px] w-[40px] shrink-0 overflow-hidden rounded bg-moonbeem-navy/40">
        {pick.poster_url ? (
          <Image
            src={pick.poster_url}
            alt=""
            fill
            sizes="40px"
            unoptimized
            className="object-cover"
          />
        ) : null}
        <span className="absolute left-0 top-0 rounded-br bg-black/70 px-1 text-caption font-semibold text-moonbeem-lime">
          {pick.position}
        </span>
      </div>

      <p className="m-0 min-w-0 flex-1 truncate text-body-sm text-moonbeem-ink">
        {pick.title}
      </p>

      <button
        type="button"
        onClick={onRemove}
        disabled={disabled}
        aria-label={`Remove ${pick.title} from your top 12`}
        className="shrink-0 rounded-full px-2 py-0.5 text-body-sm text-moonbeem-ink-subtle transition-colors hover:bg-moonbeem-magenta/20 hover:text-moonbeem-magenta disabled:cursor-not-allowed disabled:opacity-50"
      >
        ×
      </button>
    </div>
  );
}
