"use client";

// Client curator for /admin/all-films. Mirrors RecentEditsCurator's
// three-section shape but on titles — Pinned (drag-orderable),
// Hidden, Candidates (filterable pool). Every state change posts
// the full pinned+hidden state to /api/admin/titles/allfilms/reorder,
// which diffs against current DB state and applies deltas in a
// single transaction. Optimistic UI; rollback on error.

import { useMemo, useState } from "react";
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

export type AllFilmsCurationItem = {
  id: string;
  slug: string;
  title: string;
  year: number | null;
  poster_url: string | null;
  created_at: string;
  allfilms_pin_order: number | null;
  is_hidden_from_all_films: boolean;
};

type Props = {
  initialPinned: AllFilmsCurationItem[];
  initialHidden: AllFilmsCurationItem[];
  initialCandidates: AllFilmsCurationItem[];
};

function sortByCreatedDesc(
  a: AllFilmsCurationItem,
  b: AllFilmsCurationItem,
) {
  return b.created_at.localeCompare(a.created_at);
}

export default function AllFilmsCurator({
  initialPinned,
  initialHidden,
  initialCandidates,
}: Props) {
  const router = useRouter();
  const [pinned, setPinned] =
    useState<AllFilmsCurationItem[]>(initialPinned);
  const [hidden, setHidden] =
    useState<AllFilmsCurationItem[]>(initialHidden);
  const [candidates, setCandidates] = useState<AllFilmsCurationItem[]>(
    [...initialCandidates].sort(sortByCreatedDesc),
  );
  const [filter, setFilter] = useState("");
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  const filteredCandidates = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return candidates;
    return candidates.filter((c) => {
      if (c.title.toLowerCase().includes(q)) return true;
      if (c.slug.toLowerCase().includes(q)) return true;
      if (c.year && String(c.year).includes(q)) return true;
      return false;
    });
  }, [candidates, filter]);

  async function persist(
    nextPinned: AllFilmsCurationItem[],
    nextHidden: AllFilmsCurationItem[],
  ): Promise<boolean> {
    setSaving(true);
    setErrorMsg(null);
    try {
      await fetchJson("/api/admin/titles/allfilms/reorder", {
        method: "POST",
        body: {
          pinned: nextPinned.map((p, idx) => ({
            title_id: p.id,
            pin_order: idx + 1,
          })),
          hidden: nextHidden.map((h) => h.id),
        },
      });
      router.refresh();
      return true;
    } catch (err) {
      setErrorMsg(
        err instanceof RateLimitedError || err instanceof FetchJsonError
          ? err.userMessage
          : err instanceof Error
            ? err.message
            : String(err),
      );
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = pinned.findIndex((p) => p.id === active.id);
    const newIndex = pinned.findIndex((p) => p.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    const prev = pinned;
    const next = arrayMove(pinned, oldIndex, newIndex);
    setPinned(next);
    const ok = await persist(next, hidden);
    if (!ok) setPinned(prev);
  }

  async function handlePinCandidate(item: AllFilmsCurationItem) {
    if (busyId) return;
    setBusyId(item.id);
    const prevPinned = pinned;
    const prevCandidates = candidates;
    const nextPinned = [
      ...pinned,
      { ...item, allfilms_pin_order: pinned.length + 1 },
    ];
    const nextCandidates = candidates.filter((c) => c.id !== item.id);
    setPinned(nextPinned);
    setCandidates(nextCandidates);
    const ok = await persist(nextPinned, hidden);
    if (!ok) {
      setPinned(prevPinned);
      setCandidates(prevCandidates);
    }
    setBusyId(null);
  }

  async function handleUnpin(item: AllFilmsCurationItem) {
    if (busyId) return;
    setBusyId(item.id);
    const prevPinned = pinned;
    const prevCandidates = candidates;
    const nextPinned = pinned.filter((p) => p.id !== item.id);
    const nextCandidates = [
      { ...item, allfilms_pin_order: null },
      ...candidates,
    ].sort(sortByCreatedDesc);
    setPinned(nextPinned);
    setCandidates(nextCandidates);
    const ok = await persist(nextPinned, hidden);
    if (!ok) {
      setPinned(prevPinned);
      setCandidates(prevCandidates);
    }
    setBusyId(null);
  }

  async function handleHide(
    item: AllFilmsCurationItem,
    from: "pinned" | "candidates",
  ) {
    if (busyId) return;
    setBusyId(item.id);
    const prevPinned = pinned;
    const prevCandidates = candidates;
    const prevHidden = hidden;
    const nextPinned =
      from === "pinned" ? pinned.filter((p) => p.id !== item.id) : pinned;
    const nextCandidates =
      from === "candidates"
        ? candidates.filter((c) => c.id !== item.id)
        : candidates;
    const nextHidden = [
      {
        ...item,
        allfilms_pin_order: null,
        is_hidden_from_all_films: true,
      },
      ...hidden,
    ];
    setPinned(nextPinned);
    setCandidates(nextCandidates);
    setHidden(nextHidden);
    const ok = await persist(nextPinned, nextHidden);
    if (!ok) {
      setPinned(prevPinned);
      setCandidates(prevCandidates);
      setHidden(prevHidden);
    }
    setBusyId(null);
  }

  async function handleUnhide(item: AllFilmsCurationItem) {
    if (busyId) return;
    setBusyId(item.id);
    const prevHidden = hidden;
    const prevCandidates = candidates;
    const nextHidden = hidden.filter((h) => h.id !== item.id);
    const nextCandidates = [
      { ...item, is_hidden_from_all_films: false },
      ...candidates,
    ].sort(sortByCreatedDesc);
    setHidden(nextHidden);
    setCandidates(nextCandidates);
    const ok = await persist(pinned, nextHidden);
    if (!ok) {
      setHidden(prevHidden);
      setCandidates(prevCandidates);
    }
    setBusyId(null);
  }

  return (
    <div className="flex flex-col gap-8">
      {errorMsg && (
        <p className="text-body-sm text-moonbeem-magenta">{errorMsg}</p>
      )}

      <section className="flex flex-col gap-3">
        <h2 className="text-display-sm m-0">Pinned ({pinned.length})</h2>
        {pinned.length === 0 ? (
          <p className="text-body text-moonbeem-ink-muted">
            No pinned films. Pin a film from the candidate pool below.
          </p>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={pinned.map((p) => p.id)}
              strategy={verticalListSortingStrategy}
            >
              <ul
                className={`flex flex-col gap-2 ${saving ? "opacity-70" : ""}`}
                aria-busy={saving}
              >
                {pinned.map((p, idx) => (
                  <SortablePinnedRow
                    key={p.id}
                    item={p}
                    position={idx + 1}
                    onUnpin={() => handleUnpin(p)}
                    onHide={() => handleHide(p, "pinned")}
                    isBusy={busyId === p.id}
                  />
                ))}
              </ul>
            </SortableContext>
          </DndContext>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-display-sm m-0">Hidden ({hidden.length})</h2>
        {hidden.length === 0 ? (
          <p className="text-body text-moonbeem-ink-muted">No hidden films.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {hidden.map((h) => (
              <li
                key={h.id}
                className="flex items-center gap-3 rounded-md border border-white/10 bg-white/[0.02] px-3 py-2"
              >
                <PosterThumb url={h.poster_url} alt={`${h.title} poster`} />
                <TitleMeta item={h} />
                <button
                  type="button"
                  onClick={() => handleUnhide(h)}
                  disabled={busyId === h.id || saving}
                  className="rounded-md border border-white/10 px-3 py-1 text-body-sm text-moonbeem-ink-muted transition-colors hover:border-moonbeem-pink hover:text-moonbeem-pink disabled:opacity-40"
                >
                  Unhide
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-display-sm m-0">
          Candidates ({filteredCandidates.length}
          {filter ? ` / ${candidates.length}` : ""})
        </h2>
        <p className="text-caption text-moonbeem-ink-subtle m-0">
          Top {candidates.length} most-recent films not pinned and not
          hidden. Filter to find a film, then pin or hide it.
        </p>
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by title, slug, or year…"
          className="rounded-md border border-white/10 bg-black/30 px-3 py-2 text-body-sm text-moonbeem-ink placeholder:text-moonbeem-ink-subtle focus:border-moonbeem-pink focus:outline-none"
        />
        {filteredCandidates.length === 0 ? (
          <p className="text-body-sm text-moonbeem-ink-muted">
            No candidates match.
          </p>
        ) : (
          <ul className="max-h-[600px] flex-col gap-2 overflow-y-auto flex">
            {filteredCandidates.map((c) => (
              <li
                key={c.id}
                className="flex items-center gap-3 rounded-md border border-white/10 bg-white/[0.02] px-3 py-2"
              >
                <PosterThumb url={c.poster_url} alt={`${c.title} poster`} />
                <TitleMeta item={c} />
                <button
                  type="button"
                  onClick={() => handlePinCandidate(c)}
                  disabled={busyId === c.id || saving}
                  className="rounded-md border border-white/10 px-3 py-1 text-body-sm text-moonbeem-ink-muted transition-colors hover:border-moonbeem-pink hover:text-moonbeem-pink disabled:opacity-40"
                >
                  Pin
                </button>
                <button
                  type="button"
                  onClick={() => handleHide(c, "candidates")}
                  disabled={busyId === c.id || saving}
                  aria-label={`Hide ${c.title}`}
                  className="rounded-md border border-white/10 px-3 py-1 text-body-sm text-moonbeem-ink-muted transition-colors hover:border-moonbeem-magenta hover:text-moonbeem-magenta disabled:opacity-40"
                >
                  Hide
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function PosterThumb({ url, alt }: { url: string | null; alt: string }) {
  if (!url) {
    return (
      <div
        className="h-[60px] w-[40px] shrink-0 rounded-sm border border-white/10 bg-white/[0.03]"
        aria-hidden="true"
      />
    );
  }
  return (
    <div className="h-[60px] w-[40px] shrink-0 overflow-hidden rounded-sm bg-white/[0.03]">
      <Image
        src={url}
        alt={alt}
        width={40}
        height={60}
        className="h-full w-full object-cover"
        unoptimized
      />
    </div>
  );
}

function TitleMeta({ item }: { item: AllFilmsCurationItem }) {
  return (
    <div className="min-w-0 flex-1">
      <div className="truncate text-body-sm text-moonbeem-ink">
        {item.title}
        {item.year && (
          <span className="ml-2 text-moonbeem-ink-subtle">({item.year})</span>
        )}
      </div>
      <div className="truncate font-mono text-caption text-moonbeem-ink-subtle">
        /t/{item.slug}
      </div>
    </div>
  );
}

function SortablePinnedRow({
  item,
  position,
  onUnpin,
  onHide,
  isBusy,
}: {
  item: AllFilmsCurationItem;
  position: number;
  onUnpin: () => void;
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
        aria-label={`Drag ${item.title} to reorder`}
        className="cursor-grab touch-none px-1 text-moonbeem-ink-subtle hover:text-moonbeem-ink"
      >
        ⋮⋮
      </button>
      <span className="w-6 shrink-0 text-right font-mono text-body-sm text-moonbeem-ink-subtle tabular-nums">
        {position}
      </span>
      <PosterThumb url={item.poster_url} alt={`${item.title} poster`} />
      <TitleMeta item={item} />
      <button
        type="button"
        onClick={onHide}
        disabled={isBusy}
        aria-label={`Hide ${item.title}`}
        className="rounded-md border border-white/10 px-2.5 py-1 text-caption text-moonbeem-ink-muted transition-colors hover:border-moonbeem-magenta hover:text-moonbeem-magenta disabled:opacity-40"
      >
        Hide
      </button>
      <button
        type="button"
        onClick={onUnpin}
        disabled={isBusy}
        aria-label={`Unpin ${item.title}`}
        className="h-7 w-7 shrink-0 rounded-full border border-white/10 text-body-sm text-moonbeem-ink-muted transition-colors hover:border-moonbeem-magenta hover:text-moonbeem-magenta disabled:opacity-40"
      >
        ×
      </button>
    </li>
  );
}
