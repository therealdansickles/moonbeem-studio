"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
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

export type MarqueePartner = {
  id: string;
  slug: string;
  name: string;
  logo_url: string | null;
  is_marquee_visible: boolean;
  marquee_order: number;
};

export default function MarqueeCurator({
  initialVisible,
  initialHidden,
}: {
  initialVisible: MarqueePartner[];
  initialHidden: MarqueePartner[];
}) {
  const router = useRouter();
  const [visible, setVisible] = useState<MarqueePartner[]>(initialVisible);
  const [hidden, setHidden] = useState<MarqueePartner[]>(initialHidden);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = visible.findIndex((p) => p.id === active.id);
    const newIndex = visible.findIndex((p) => p.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    const prev = visible;
    const next = arrayMove(visible, oldIndex, newIndex);
    setVisible(next);
    setSaving(true);
    setErrorMsg(null);
    try {
      await fetchJson("/api/admin/partners/marquee/reorder", {
        method: "POST",
        body: {
          positions: next.map((p, idx) => ({
            partner_id: p.id,
            position: idx + 1,
          })),
        },
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
      setVisible(prev);
    } finally {
      setSaving(false);
    }
  }

  async function handleHide(p: MarqueePartner) {
    if (busyId) return;
    setBusyId(p.id);
    setErrorMsg(null);
    const prevVisible = visible;
    const prevHidden = hidden;
    setVisible(visible.filter((x) => x.id !== p.id));
    setHidden([{ ...p, is_marquee_visible: false }, ...hidden]);
    try {
      await fetchJson(`/api/admin/partners/${p.id}`, {
        method: "PATCH",
        body: { is_marquee_visible: false },
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
      setVisible(prevVisible);
      setHidden(prevHidden);
    } finally {
      setBusyId(null);
    }
  }

  async function handleShow(p: MarqueePartner) {
    if (busyId) return;
    setBusyId(p.id);
    setErrorMsg(null);
    const prevVisible = visible;
    const prevHidden = hidden;
    setHidden(hidden.filter((x) => x.id !== p.id));
    setVisible([
      ...visible,
      { ...p, is_marquee_visible: true, marquee_order: visible.length + 1 },
    ]);
    try {
      await fetchJson(`/api/admin/partners/${p.id}`, {
        method: "PATCH",
        body: { is_marquee_visible: true },
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
      setVisible(prevVisible);
      setHidden(prevHidden);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="flex flex-col gap-8">
      {errorMsg && (
        <p className="text-body-sm text-moonbeem-magenta">{errorMsg}</p>
      )}

      <section className="flex flex-col gap-3">
        <h2 className="text-display-sm m-0">
          On the marquee ({visible.length})
        </h2>
        {visible.length === 0 ? (
          <p className="text-body text-moonbeem-ink-muted">
            No partners on the marquee. Add one below.
          </p>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={visible.map((p) => p.id)}
              strategy={verticalListSortingStrategy}
            >
              <ul
                className={`flex flex-col gap-2 ${saving ? "opacity-70" : ""}`}
                aria-busy={saving}
              >
                {visible.map((p, idx) => (
                  <SortableMarqueeRow
                    key={p.id}
                    item={p}
                    position={idx + 1}
                    onHide={() => handleHide(p)}
                    isBusy={busyId === p.id}
                  />
                ))}
              </ul>
            </SortableContext>
          </DndContext>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-display-sm m-0">
          Add to marquee ({hidden.length})
        </h2>
        {hidden.length === 0 ? (
          <p className="text-body text-moonbeem-ink-muted">
            All partners are on the marquee.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {hidden.map((p) => (
              <li
                key={p.id}
                className="flex items-center gap-3 rounded-md border border-white/10 bg-white/[0.02] px-3 py-2"
              >
                <LogoThumb url={p.logo_url} alt={`${p.name} logo`} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-body-sm text-moonbeem-ink">
                    {p.name}
                  </div>
                  <div className="truncate font-mono text-caption text-moonbeem-ink-subtle">
                    /p/{p.slug}
                    {!p.logo_url && (
                      <span className="ml-2 text-moonbeem-ink-subtle">· no logo</span>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => handleShow(p)}
                  disabled={busyId === p.id}
                  className="rounded-md border border-white/10 px-3 py-1 text-body-sm text-moonbeem-ink-muted transition-colors hover:border-moonbeem-pink hover:text-moonbeem-pink disabled:opacity-40"
                >
                  + Add
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function LogoThumb({ url, alt }: { url: string | null; alt: string }) {
  if (!url) {
    return (
      <div
        className="h-[40px] w-[80px] shrink-0 rounded-sm border border-white/10 bg-white/[0.03]"
        aria-hidden="true"
      />
    );
  }
  return (
    <div className="h-[40px] w-[80px] shrink-0 overflow-hidden rounded-sm bg-white/[0.03]">
      <Image
        src={url}
        alt={alt}
        width={80}
        height={40}
        className="h-full w-full object-contain"
        unoptimized
      />
    </div>
  );
}

function SortableMarqueeRow({
  item,
  position,
  onHide,
  isBusy,
}: {
  item: MarqueePartner;
  position: number;
  onHide: () => void;
  isBusy: boolean;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.id });

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
        aria-label={`Drag ${item.name} to reorder`}
        className="cursor-grab touch-none px-1 text-moonbeem-ink-subtle hover:text-moonbeem-ink"
      >
        ⋮⋮
      </button>
      <span className="w-6 shrink-0 text-right font-mono text-body-sm text-moonbeem-ink-subtle tabular-nums">
        {position}
      </span>
      <LogoThumb url={item.logo_url} alt={`${item.name} logo`} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-body-sm text-moonbeem-ink">
          {item.name}
        </div>
        <div className="truncate font-mono text-caption text-moonbeem-ink-subtle">
          /p/{item.slug}
          {!item.logo_url && (
            <span className="ml-2 text-moonbeem-ink-subtle">· no logo</span>
          )}
        </div>
      </div>
      <button
        type="button"
        onClick={onHide}
        disabled={isBusy}
        aria-label={`Hide ${item.name} from marquee`}
        className="h-7 w-7 shrink-0 rounded-full border border-white/10 text-body-sm text-moonbeem-ink-muted transition-colors hover:border-moonbeem-magenta hover:text-moonbeem-magenta disabled:opacity-40"
      >
        ×
      </button>
    </li>
  );
}
