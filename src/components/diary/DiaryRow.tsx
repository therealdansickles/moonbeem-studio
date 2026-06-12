// Phase 1C — one diary entry rendered as the EpisodeList card-row idiom.
// Presentational (no client hooks) so it renders in the server ProfileView
// section AND inside the client DiaryManageRow. The optional `action` slot
// lets /me/diary inject an owner delete control.

import Link from "next/link";
import type { ReactNode } from "react";
import { StarRatingDisplay } from "@/components/StarRating";
import type { DiaryEntry } from "@/lib/queries/diary";

function formatWatchedOn(d: string): string {
  const dt = new Date(`${d}T00:00:00Z`);
  if (Number.isNaN(dt.getTime())) return d;
  return dt.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export default function DiaryRow({
  entry,
  action,
}: {
  entry: DiaryEntry;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-4 rounded-xl border border-white/10 bg-white/[0.02] p-3">
      <div className="relative h-[68px] w-[46px] shrink-0 overflow-hidden rounded-md bg-moonbeem-navy/40">
        {entry.poster_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={entry.poster_url}
            alt=""
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center p-1 text-center text-caption text-moonbeem-ink-subtle">
            {entry.title_name}
          </div>
        )}
      </div>

      <div className="min-w-0 flex-1">
        {entry.title_slug ? (
          <Link
            href={`/t/${entry.title_slug}`}
            className="block truncate text-body-sm font-medium text-moonbeem-ink hover:text-moonbeem-pink"
          >
            {entry.title_name}
          </Link>
        ) : (
          <span className="block truncate text-body-sm font-medium text-moonbeem-ink">
            {entry.title_name}
            {entry.raw_year ? ` (${entry.raw_year})` : ""}
          </span>
        )}
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <span className="text-caption text-moonbeem-ink-subtle">
            Watched {formatWatchedOn(entry.watched_on)}
          </span>
          {entry.rating != null && (
            <StarRatingDisplay value={entry.rating} size={12} />
          )}
          {entry.rewatch && (
            <span className="rounded-full bg-white/5 px-2 py-0.5 text-caption text-moonbeem-ink-subtle">
              Rewatch
            </span>
          )}
          {entry.has_review && entry.title_slug && (
            <Link
              href={`/t/${entry.title_slug}#reviews`}
              className="rounded-full border border-moonbeem-pink/30 bg-moonbeem-pink/10 px-2 py-0.5 text-caption text-moonbeem-pink hover:bg-moonbeem-pink/20"
            >
              Review
            </Link>
          )}
        </div>
      </div>

      {action}
    </div>
  );
}
