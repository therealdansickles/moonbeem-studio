"use client";

import { useEffect, useRef, useState } from "react";
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

export type FeaturedTitle = {
  id: string;
  slug: string;
  title: string;
  year: number | null;
  poster_url: string | null;
  featured_order: number;
};

type SearchHit = {
  id: string;
  slug: string;
  title: string;
  year: number | null;
  poster_url: string | null;
  partner_id: string | null;
  is_active: boolean;
  is_public: boolean;
};

const SEARCH_DEBOUNCE_MS = 300;

export default function FeaturedCurator({
  initialTitles,
}: {
  initialTitles: FeaturedTitle[];
}) {
  const router = useRouter();
  const [items, setItems] = useState<FeaturedTitle[]>(initialTitles);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = items.findIndex((t) => t.id === active.id);
    const newIndex = items.findIndex((t) => t.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    const next = arrayMove(items, oldIndex, newIndex);
    setItems(next);
    setSaving(true);
    setErrorMsg(null);
    try {
      const res = await fetch("/api/admin/titles/featured/reorder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          positions: next.map((t, idx) => ({
            title_id: t.id,
            position: idx + 1,
          })),
        }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `reorder ${res.status}`);
      }
      router.refresh();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setItems(items); // rollback
    } finally {
      setSaving(false);
    }
  }

  async function handleRemove(t: FeaturedTitle) {
    if (removingId) return;
    setRemovingId(t.id);
    setErrorMsg(null);
    const prev = items;
    setItems(items.filter((x) => x.id !== t.id));
    try {
      const res = await fetch(`/api/admin/titles/${t.slug}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_featured: false }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `remove ${res.status}`);
      }
      router.refresh();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setItems(prev);
    } finally {
      setRemovingId(null);
    }
  }

  async function handleAdd(hit: SearchHit) {
    setErrorMsg(null);
    try {
      const res = await fetch(`/api/admin/titles/${hit.slug}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_featured: true }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `add ${res.status}`);
      }
      const j = (await res.json()) as {
        title?: { featured_order?: number };
      };
      const nextOrder = j.title?.featured_order ?? items.length + 1;
      setItems([
        ...items,
        {
          id: hit.id,
          slug: hit.slug,
          title: hit.title,
          year: hit.year,
          poster_url: hit.poster_url,
          featured_order: nextOrder,
        },
      ]);
      router.refresh();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="flex flex-col gap-8">
      {errorMsg && (
        <p className="text-body-sm text-moonbeem-magenta">{errorMsg}</p>
      )}

      <section className="flex flex-col gap-3">
        <h2 className="text-display-sm m-0">
          Currently featured ({items.length})
        </h2>
        {items.length === 0 ? (
          <p className="text-body text-moonbeem-ink-muted">
            No featured titles yet. Add one below.
          </p>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={items.map((t) => t.id)}
              strategy={verticalListSortingStrategy}
            >
              <ul
                className={`flex flex-col gap-2 ${saving ? "opacity-70" : ""}`}
                aria-busy={saving}
              >
                {items.map((t, idx) => (
                  <SortableFeaturedRow
                    key={t.id}
                    item={t}
                    position={idx + 1}
                    onRemove={() => handleRemove(t)}
                    isRemoving={removingId === t.id}
                  />
                ))}
              </ul>
            </SortableContext>
          </DndContext>
        )}
      </section>

      <AddToFeaturedSearch
        existingIds={new Set(items.map((t) => t.id))}
        onAdd={handleAdd}
      />
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

function SortableFeaturedRow({
  item,
  position,
  onRemove,
  isRemoving,
}: {
  item: FeaturedTitle;
  position: number;
  onRemove: () => void;
  isRemoving: boolean;
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
      <button
        type="button"
        onClick={onRemove}
        disabled={isRemoving}
        aria-label={`Unfeature ${item.title}`}
        className="h-7 w-7 shrink-0 rounded-full border border-white/10 text-body-sm text-moonbeem-ink-muted transition-colors hover:border-moonbeem-magenta hover:text-moonbeem-magenta disabled:opacity-40"
      >
        ×
      </button>
    </li>
  );
}

function AddToFeaturedSearch({
  existingIds,
  onAdd,
}: {
  existingIds: Set<string>;
  onAdd: (hit: SearchHit) => void;
}) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchErr, setSearchErr] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setHits([]);
      setSearchErr(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/admin/titles/search?q=${encodeURIComponent(q)}`,
        );
        const j = await res.json();
        if (!res.ok) {
          setSearchErr(j.error ?? `search ${res.status}`);
          setHits([]);
        } else {
          setSearchErr(null);
          setHits((j.results ?? []) as SearchHit[]);
        }
      } catch (e) {
        setSearchErr(String(e));
        setHits([]);
      } finally {
        setSearching(false);
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query]);

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-display-sm m-0">Add to Featured</h2>
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search the catalog… (min 2 chars)"
        className="rounded-md border border-white/10 bg-black/30 px-3 py-2 text-body-sm text-moonbeem-ink placeholder:text-moonbeem-ink-subtle focus:border-moonbeem-pink focus:outline-none"
      />
      {searchErr && (
        <p className="text-caption text-moonbeem-magenta">{searchErr}</p>
      )}
      <div className="max-h-80 overflow-y-auto rounded-lg border border-white/5 bg-black/30">
        {searching && (
          <p className="p-3 text-caption text-moonbeem-ink-subtle">Searching…</p>
        )}
        {!searching && query.trim().length >= 2 && hits.length === 0 && (
          <p className="p-3 text-caption text-moonbeem-ink-subtle">No matches.</p>
        )}
        {hits.map((h) => {
          const alreadyFeatured = existingIds.has(h.id);
          const isAdding = adding === h.id;
          return (
            <button
              key={h.id}
              type="button"
              disabled={alreadyFeatured || isAdding}
              onClick={async () => {
                setAdding(h.id);
                try {
                  await onAdd(h);
                  setQuery("");
                  setHits([]);
                } finally {
                  setAdding(null);
                }
              }}
              className={`flex w-full items-center justify-between gap-3 border-b border-white/5 px-3 py-2 text-left last:border-b-0 transition-colors ${
                alreadyFeatured
                  ? "cursor-not-allowed opacity-60"
                  : "hover:bg-moonbeem-pink/5"
              }`}
            >
              <div className="flex min-w-0 items-center gap-3">
                <PosterThumb url={h.poster_url} alt={`${h.title} poster`} />
                <div className="min-w-0">
                  <div className="truncate text-body-sm text-moonbeem-ink">
                    {h.title}
                    {h.year && (
                      <span className="ml-2 text-moonbeem-ink-subtle">
                        ({h.year})
                      </span>
                    )}
                  </div>
                  <div className="font-mono text-caption text-moonbeem-ink-subtle">
                    /t/{h.slug}
                  </div>
                </div>
              </div>
              <span className="text-caption text-moonbeem-ink-subtle whitespace-nowrap">
                {alreadyFeatured ? "already featured" : isAdding ? "adding…" : "+ Feature"}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
