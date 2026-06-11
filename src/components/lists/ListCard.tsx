// Phase 1D — a list summary card for the public profile "Lists" section.
// Presentational; links to the list detail page.

import Link from "next/link";
import type { PublicListSummary } from "@/lib/queries/lists";

export default function ListCard({
  handle,
  list,
}: {
  handle: string;
  list: PublicListSummary;
}) {
  return (
    <Link
      href={`/c/${handle}/list/${list.id}`}
      className="group flex items-center gap-4 rounded-xl border border-white/10 bg-white/[0.02] p-3 transition-colors hover:border-moonbeem-pink/40"
    >
      <div className="flex shrink-0 -space-x-3">
        {list.posters.length > 0 ? (
          list.posters.slice(0, 4).map((p, i) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={i}
              src={p}
              alt=""
              className="h-[60px] w-[40px] rounded-md border border-moonbeem-black object-cover"
            />
          ))
        ) : (
          <div className="h-[60px] w-[40px] rounded-md bg-moonbeem-navy/40" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-body-sm font-medium text-moonbeem-ink group-hover:text-moonbeem-pink">
            {list.name}
          </span>
          {list.kind === "watchlist" && (
            <span className="rounded-full border border-moonbeem-pink/30 bg-moonbeem-pink/10 px-2 py-0.5 text-caption text-moonbeem-pink">
              Watchlist
            </span>
          )}
        </div>
        <span className="text-caption text-moonbeem-ink-subtle">
          {list.item_count} {list.item_count === 1 ? "film" : "films"}
        </span>
      </div>
      <span
        aria-hidden
        className="text-moonbeem-ink-subtle group-hover:text-moonbeem-pink"
      >
        →
      </span>
    </Link>
  );
}
