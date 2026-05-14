"use client";

// Top 12 builder — the interactive surface of /me/top-12.
//
// Layout: desktop is two columns (discovery 2/3 left, picks panel
// 1/3 sticky right); mobile stacks with the picks panel on top,
// collapsed by default, discovery below. DOM order is picks-first so
// the mobile stack is natural; `md:order-*` flips it on desktop.
//
// Persistence is real-time and optimistic: every add / remove /
// reorder updates local state immediately and fires the matching
// /api/profile/top-titles/* endpoint. On failure the previous state
// is restored and a short error line is shown. There is no separate
// save step — "Done for now" just routes back to /me.

import { useState, useMemo, useRef, useEffect, useCallback } from "react";
import Link from "next/link";
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
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import {
  fetchJson,
  FetchJsonError,
  RateLimitedError,
} from "@/lib/fetch-json";
import { useDragScroll } from "@/hooks/useDragScroll";
import SortablePickCard from "./SortablePickCard";
import BuilderTitleCard from "./BuilderTitleCard";

export type BuilderTitle = {
  id: string;
  slug: string;
  title: string;
  poster_url: string | null;
  year: number | null;
  distributor: string | null;
};

export type BuilderPick = {
  title_id: string;
  position: number;
  slug: string;
  title: string;
  poster_url: string | null;
};

export type PartnerSection = {
  partner: { id: string; slug: string; name: string };
  titles: BuilderTitle[];
};

export type CuratedListSection = {
  slug: string;
  name: string;
  // titles is the carousel preview (capped); totalCount is the full
  // list size, used for the "View all N →" link to /lists/[slug].
  titles: BuilderTitle[];
  totalCount: number;
};

const MAX_PICKS = 12;
const MIN_PICKS = 3;
const SEARCH_DEBOUNCE_MS = 300;
const SEARCH_MIN_LEN = 2;

function mutationError(err: unknown, fallback: string): string {
  if (err instanceof RateLimitedError || err instanceof FetchJsonError) {
    return err.userMessage;
  }
  return fallback;
}

export default function Top12Builder({
  initialPicks,
  featured,
  curatedLists,
  recentlyAdded,
}: {
  initialPicks: BuilderPick[];
  featured: BuilderTitle[];
  // Editorial discovery carousels (AFI Top 100, Top Rated Series,
  // ...), already ordered by display_order from the page query.
  curatedLists: CuratedListSection[];
  recentlyAdded: BuilderTitle[];
  // byPartner is still wired end to end — the page query builds it
  // and passes it down — but it is not rendered in v1.5 (see the
  // discovery surface below). Kept on the type so the plumbing
  // survives; re-destructure it to bring the sections back.
  byPartner: PartnerSection[];
}) {
  const router = useRouter();
  const [picks, setPicks] = useState<BuilderPick[]>(() =>
    [...initialPicks].sort((a, b) => a.position - b.position),
  );
  const [picksExpanded, setPicksExpanded] = useState(false);
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<BuilderTitle[]>([]);
  const [searching, setSearching] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());

  const abortRef = useRef<AbortController | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  const pickedIds = useMemo(
    () => new Set(picks.map((p) => p.title_id)),
    [picks],
  );
  const atCapacity = picks.length >= MAX_PICKS;
  const canFinish = picks.length >= MIN_PICKS;
  const searchActive = query.trim().length >= SEARCH_MIN_LEN;

  // Real-time search: 300ms debounce, AbortController-cancelled so a
  // stale in-flight request can't clobber newer results.
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < SEARCH_MIN_LEN) {
      setSearchResults([]);
      setSearching(false);
      abortRef.current?.abort();
      return;
    }
    setSearching(true);
    const t = setTimeout(async () => {
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      try {
        const res = await fetch(
          `/api/search?q=${encodeURIComponent(trimmed)}`,
          { signal: ac.signal },
        );
        if (!res.ok) throw new Error(`search ${res.status}`);
        const json = (await res.json()) as { results: BuilderTitle[] };
        if (!ac.signal.aborted) setSearchResults(json.results);
      } catch (err) {
        if ((err as Error).name !== "AbortError") setSearchResults([]);
      } finally {
        if (!ac.signal.aborted) setSearching(false);
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query]);

  const markPending = useCallback((id: string, on: boolean) => {
    setPendingIds((cur) => {
      const next = new Set(cur);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  async function addPick(t: BuilderTitle) {
    if (atCapacity || pickedIds.has(t.id) || pendingIds.has(t.id)) return;
    const nextPosition = picks.length + 1;
    const prev = picks;
    setPicks([
      ...picks,
      {
        title_id: t.id,
        position: nextPosition,
        slug: t.slug,
        title: t.title,
        poster_url: t.poster_url,
      },
    ]);
    setErrorMsg(null);
    markPending(t.id, true);
    try {
      await fetchJson("/api/profile/top-titles/add", {
        method: "POST",
        body: { title_id: t.id, position: nextPosition },
      });
    } catch (err) {
      setPicks(prev);
      setErrorMsg(mutationError(err, "Couldn't add that film. Try again."));
    } finally {
      markPending(t.id, false);
    }
  }

  async function removePick(titleId: string) {
    if (pendingIds.has(titleId)) return;
    const prev = picks;
    const next = picks
      .filter((p) => p.title_id !== titleId)
      .sort((a, b) => a.position - b.position)
      .map((p, i) => ({ ...p, position: i + 1 }));
    setPicks(next);
    setErrorMsg(null);
    markPending(titleId, true);
    try {
      await fetchJson("/api/profile/top-titles/remove", {
        method: "POST",
        body: { title_id: titleId },
      });
    } catch (err) {
      setPicks(prev);
      setErrorMsg(mutationError(err, "Couldn't remove that film. Try again."));
    } finally {
      markPending(titleId, false);
    }
  }

  function toggle(t: BuilderTitle) {
    if (pickedIds.has(t.id)) removePick(t.id);
    else addPick(t);
  }

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = picks.findIndex((p) => p.title_id === active.id);
    const newIndex = picks.findIndex((p) => p.title_id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    const prev = picks;
    const next = arrayMove(picks, oldIndex, newIndex).map((p, i) => ({
      ...p,
      position: i + 1,
    }));
    setPicks(next);
    setErrorMsg(null);
    try {
      await fetchJson("/api/profile/top-titles/reorder", {
        method: "POST",
        body: {
          positions: next.map((p) => ({
            title_id: p.title_id,
            position: p.position,
          })),
        },
      });
    } catch (err) {
      setPicks(prev);
      setErrorMsg(mutationError(err, "Couldn't save the new order. Try again."));
    }
  }

  return (
    <div className="min-h-screen bg-[radial-gradient(ellipse_at_center,_#011754_0%,_#121212_100%)] px-6 py-12">
      <div className="mx-auto max-w-6xl">
        <header className="flex flex-col gap-3">
          <h1 className="font-wordmark text-display-md text-moonbeem-pink m-0">
            Build your top 12
          </h1>
          <p className="m-0 max-w-2xl text-body text-moonbeem-ink-muted leading-relaxed">
            Pick films and series that mean something to you. They&apos;ll show
            on your profile, and you&apos;ll earn from rentals and purchases
            that come through your profile.
          </p>
          <p className="m-0 text-body-sm text-moonbeem-ink-subtle">
            3 minimum, 12 maximum. Add or remove anytime.
          </p>
        </header>

        <div className="mt-8 grid gap-8 md:grid-cols-3">
          {/* Picks panel — DOM-first for the mobile stack, desktop
              right column via md:order-2. */}
          <aside className="md:order-2 md:col-span-1">
            <div className="flex flex-col gap-4 md:sticky md:top-20">
              <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
                <div className="flex items-center justify-between gap-3">
                  <h2 className="m-0 text-body font-medium text-moonbeem-ink">
                    Your picks ({picks.length} of 12)
                  </h2>
                  <button
                    type="button"
                    onClick={() => setPicksExpanded((v) => !v)}
                    className="text-caption text-moonbeem-ink-muted hover:text-moonbeem-pink md:hidden"
                  >
                    {picksExpanded ? "Collapse" : "Expand"}
                  </button>
                </div>

                {/* The poster list is the collapsible part on mobile;
                    header + Done stay visible so the count and the
                    finish action are always reachable. */}
                <div
                  className={
                    picksExpanded ? "mt-4" : "mt-4 hidden md:block"
                  }
                >
                  {picks.length === 0 ? (
                    <p className="m-0 text-body-sm text-moonbeem-ink-subtle">
                      Empty — search or browse below to add films.
                    </p>
                  ) : (
                    <DndContext
                      sensors={sensors}
                      collisionDetection={closestCenter}
                      onDragEnd={handleDragEnd}
                    >
                      <SortableContext
                        items={picks.map((p) => p.title_id)}
                        strategy={verticalListSortingStrategy}
                      >
                        <div className="flex flex-col gap-2">
                          {picks.map((p) => (
                            <SortablePickCard
                              key={p.title_id}
                              pick={p}
                              disabled={pendingIds.has(p.title_id)}
                              onRemove={() => removePick(p.title_id)}
                            />
                          ))}
                        </div>
                      </SortableContext>
                    </DndContext>
                  )}
                </div>

                <div className="mt-4">
                  {canFinish ? (
                    <button
                      type="button"
                      onClick={() => router.push("/me")}
                      className="w-full rounded-md bg-moonbeem-pink px-4 py-2 text-body-sm font-semibold text-moonbeem-navy transition-opacity hover:opacity-90"
                    >
                      Done for now →
                    </button>
                  ) : (
                    <>
                      <button
                        type="button"
                        disabled
                        className="w-full cursor-not-allowed rounded-md bg-white/5 px-4 py-2 text-body-sm font-semibold text-moonbeem-ink-subtle"
                      >
                        Done for now →
                      </button>
                      <p className="m-0 mt-2 text-center text-caption text-moonbeem-ink-subtle">
                        Pick at least 3 to finish
                      </p>
                    </>
                  )}
                </div>

                {errorMsg && (
                  <p className="m-0 mt-3 text-caption text-moonbeem-magenta">
                    {errorMsg}
                  </p>
                )}
              </div>

              {/* Inspiration placeholder — reserves layout space for
                  the v2 curator-picks surface. No CTA by design. */}
              <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.015] p-4">
                <p className="m-0 text-body-sm font-medium text-moonbeem-ink-muted">
                  Need inspiration?
                </p>
                <p className="m-0 mt-1 text-caption text-moonbeem-ink-subtle leading-relaxed">
                  Coming soon: see what filmmakers and curators on Moonbeem
                  have picked for their top 12.
                </p>
              </div>
            </div>
          </aside>

          {/* Discovery — DOM-second, desktop left column. */}
          <div className="flex flex-col gap-8 md:order-1 md:col-span-2">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search films..."
              className="w-full rounded-md border border-white/10 bg-white/[0.03] px-4 py-2.5 text-body text-moonbeem-ink placeholder:text-moonbeem-ink-subtle focus:border-moonbeem-pink focus:outline-none"
            />

            {searchActive ? (
              <section>
                {searching && searchResults.length === 0 ? (
                  <p className="m-0 text-body-sm text-moonbeem-ink-subtle">
                    Searching…
                  </p>
                ) : searchResults.length === 0 ? (
                  <p className="m-0 text-body-sm text-moonbeem-ink-subtle">
                    No films found for &ldquo;{query.trim()}&rdquo;.
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-4">
                    {searchResults.map((r) => (
                      <BuilderTitleCard
                        key={r.id}
                        title={r}
                        isAdded={pickedIds.has(r.id)}
                        atCapacity={atCapacity}
                        pending={pendingIds.has(r.id)}
                        onToggle={() => toggle(r)}
                      />
                    ))}
                  </div>
                )}
              </section>
            ) : (
              <>
                <BrowseRow
                  heading="Featured"
                  titles={featured}
                  pickedIds={pickedIds}
                  atCapacity={atCapacity}
                  pendingIds={pendingIds}
                  onToggle={toggle}
                  viewAllHref="/lists/featured"
                  viewAllCount={featured.length}
                />
                {curatedLists.map((list) => (
                  <BrowseRow
                    key={list.slug}
                    heading={list.name}
                    titles={list.titles}
                    pickedIds={pickedIds}
                    atCapacity={atCapacity}
                    pendingIds={pendingIds}
                    onToggle={toggle}
                    viewAllHref={`/lists/${list.slug}`}
                    viewAllCount={list.totalCount}
                  />
                ))}
                <BrowseRow
                  heading="Recently added"
                  titles={recentlyAdded}
                  pickedIds={pickedIds}
                  atCapacity={atCapacity}
                  pendingIds={pendingIds}
                  onToggle={toggle}
                  viewAllHref="/lists/recently-added"
                />
                {/* By-partner sections are intentionally not rendered in
                    v1.5 — the catalog has too few partners with enough
                    titles for the grouping to read well. The byPartner
                    prop, the page query that builds it, the PartnerSection
                    type, and BrowseRow itself all stay in place. To bring
                    the sections back, re-destructure byPartner above and
                    map it to <BrowseRow> rows here. v2 trigger: >= 3
                    partners with >= 3 titles each. */}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function BrowseRow({
  heading,
  titles,
  pickedIds,
  atCapacity,
  pendingIds,
  onToggle,
  viewAllHref,
  viewAllCount,
}: {
  heading: string;
  titles: BuilderTitle[];
  pickedIds: Set<string>;
  atCapacity: boolean;
  pendingIds: Set<string>;
  onToggle: (t: BuilderTitle) => void;
  // Only the curated-list rows pass these — they have a dedicated
  // /lists/[slug] page. Featured / Recently added stay preview-only.
  viewAllHref?: string;
  viewAllCount?: number;
}) {
  // Click-and-drag horizontal scroll on desktop (touch scroll stays
  // native). The hook also suppresses the click that would otherwise
  // fire on a card's +Add button when the press was actually a drag.
  const scrollRef = useDragScroll();
  if (titles.length === 0) return null;
  return (
    <section>
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-caption font-medium uppercase tracking-wider text-moonbeem-pink">
          {heading}
        </h2>
        {viewAllHref && (
          <Link
            href={viewAllHref}
            className="shrink-0 text-caption text-moonbeem-ink-muted transition-colors hover:text-moonbeem-pink"
          >
            View all{viewAllCount != null ? ` ${viewAllCount}` : ""} →
          </Link>
        )}
      </div>
      <div
        ref={scrollRef}
        className="flex gap-4 overflow-x-auto pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {titles.map((t) => (
          <BuilderTitleCard
            key={t.id}
            title={t}
            isAdded={pickedIds.has(t.id)}
            atCapacity={atCapacity}
            pending={pendingIds.has(t.id)}
            onToggle={() => onToggle(t)}
          />
        ))}
      </div>
    </section>
  );
}
