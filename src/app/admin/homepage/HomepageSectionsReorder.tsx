"use client";

// Drag-to-reorder UI for the lateral order of homepage carousels.
// Lives at the top of /admin/homepage, ABOVE the existing curator
// card list. Saves immediately on drop via POST /api/admin/homepage/
// sections/reorder; mirrors FeaturedCurator's dnd-kit pattern.
//
// This component manages ORDER only — section-level visibility
// (hiding an entire carousel) is out of slice D's scope.

import { useState } from "react";
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
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  fetchJson,
  FetchJsonError,
  RateLimitedError,
} from "@/lib/fetch-json";
import {
  HOMEPAGE_SECTION_LABELS,
  type HomepageSectionSlug,
} from "@/lib/homepage-sections";

type Props = {
  initialOrder: HomepageSectionSlug[];
};

export default function HomepageSectionsReorder({ initialOrder }: Props) {
  const router = useRouter();
  const [order, setOrder] = useState<HomepageSectionSlug[]>(initialOrder);
  const [saving, setSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = order.findIndex((s) => s === active.id);
    const newIndex = order.findIndex((s) => s === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    const prev = order;
    const next = arrayMove(order, oldIndex, newIndex);
    setOrder(next);
    setSaving(true);
    setErrorMsg(null);
    try {
      await fetchJson("/api/admin/homepage/sections/reorder", {
        method: "POST",
        body: { order: next },
      });
      router.refresh();
    } catch (err) {
      setErrorMsg(
        err instanceof RateLimitedError || err instanceof FetchJsonError
          ? err.userMessage
          : err instanceof Error
            ? err.message
            : String(err),
      );
      setOrder(prev);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 className="text-display-sm m-0">Section order</h2>
        <p className="m-0 text-body-sm text-moonbeem-ink-muted">
          Drag to reorder the homepage&apos;s vertical layout. Changes
          take effect on the next homepage visit. Per-row pin and
          hide inside each section is curated below.
        </p>
      </div>
      {errorMsg && (
        <p className="text-body-sm text-moonbeem-magenta">{errorMsg}</p>
      )}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={order}
          strategy={verticalListSortingStrategy}
        >
          <ul
            className={`flex flex-col gap-2 ${saving ? "opacity-70" : ""}`}
            aria-busy={saving}
          >
            {order.map((slug, idx) => (
              <SortableSectionRow
                key={slug}
                slug={slug}
                position={idx + 1}
              />
            ))}
          </ul>
        </SortableContext>
      </DndContext>
    </section>
  );
}

function SortableSectionRow({
  slug,
  position,
}: {
  slug: HomepageSectionSlug;
  position: number;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: slug });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 20 : undefined,
  };

  return (
    <li
      ref={setNodeRef}
      style={style}
      className={`flex items-center gap-3 rounded-md border bg-white/[0.02] px-3 py-2 ${
        isDragging
          ? "border-moonbeem-pink shadow-[0_8px_24px_rgba(245,197,225,0.25)]"
          : "border-white/10"
      }`}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        aria-label={`Drag ${HOMEPAGE_SECTION_LABELS[slug]} to reorder`}
        className="cursor-grab touch-none px-1 text-moonbeem-ink-subtle hover:text-moonbeem-ink"
      >
        ⋮⋮
      </button>
      <span className="w-6 shrink-0 text-right font-mono text-body-sm text-moonbeem-ink-subtle tabular-nums">
        {position}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-body-sm text-moonbeem-ink">
          {HOMEPAGE_SECTION_LABELS[slug]}
        </div>
        <div className="truncate font-mono text-caption text-moonbeem-ink-subtle">
          {slug}
        </div>
      </div>
    </li>
  );
}
