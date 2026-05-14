"use client";

// A title card in the discovery surface (search results + browse
// rows). Carries the +Add / ✓ Added toggle. When the user is at 12
// picks, the Add affordance is disabled with an explanatory tooltip;
// already-added cards stay interactive so they can be removed.

import Image from "next/image";
import type { BuilderTitle } from "./Top12Builder";

export default function BuilderTitleCard({
  title,
  isAdded,
  atCapacity,
  pending,
  onToggle,
  fill = false,
}: {
  title: BuilderTitle;
  isAdded: boolean;
  atCapacity: boolean;
  pending: boolean;
  onToggle: () => void;
  // fill=false (default): fixed 130px, shrink-0 — the carousel rows
  // on /me/top-12. fill=true: width fills the parent cell — the
  // responsive grid on /lists/[slug].
  fill?: boolean;
}) {
  const addDisabled = !isAdded && atCapacity;
  const meta = [title.year, title.distributor].filter(Boolean).join(" · ");

  return (
    <div
      className={`flex select-none flex-col gap-2 ${
        fill ? "w-full" : "w-[130px] shrink-0"
      }`}
    >
      <div className="relative aspect-[2/3] w-full overflow-hidden rounded-lg bg-moonbeem-navy/40">
        {title.poster_url ? (
          <Image
            src={title.poster_url}
            alt={`${title.title} poster`}
            fill
            sizes={fill ? "(max-width: 640px) 45vw, 200px" : "130px"}
            unoptimized
            draggable={false}
            className="select-none object-cover pointer-events-none"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center p-2 text-center">
            <span className="font-wordmark text-body-sm text-moonbeem-ink">
              {title.title}
            </span>
          </div>
        )}
      </div>

      {/* flex-1 lets the text block absorb the height difference
          between 1- and 2-line titles (and the optional meta line),
          so the button below always lands at the same vertical
          position across every card in a row. */}
      <div className="flex flex-1 flex-col gap-0.5">
        <p className="m-0 line-clamp-2 text-caption font-medium leading-tight text-moonbeem-ink">
          {title.title}
        </p>
        {meta && (
          <p className="m-0 text-caption text-moonbeem-ink-subtle">{meta}</p>
        )}
      </div>

      <button
        type="button"
        onClick={onToggle}
        disabled={pending || addDisabled}
        title={
          addDisabled ? "Remove a pick first to add another" : undefined
        }
        className={`rounded-md px-2 py-1 text-caption font-medium transition-colors disabled:cursor-not-allowed ${
          isAdded
            ? "border border-moonbeem-lime/40 bg-moonbeem-lime/10 text-moonbeem-lime hover:bg-moonbeem-lime/20"
            : addDisabled
              ? "border border-white/10 text-moonbeem-ink-subtle opacity-50"
              : "border border-white/15 text-moonbeem-ink hover:border-moonbeem-pink hover:text-moonbeem-pink"
        }`}
      >
        {isAdded ? "✓ Added" : "+ Add"}
      </button>
    </div>
  );
}
