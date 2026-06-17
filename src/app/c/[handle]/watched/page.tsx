// Phase 2E.3 — public watched grid (read-only). Mirrors the list-detail page
// anatomy: resolve the handle to a creator (anon SSR), 404 a missing/stub/
// unclaimed handle, then render the creator's public watched films as a poster
// grid identical to list detail. Empty state renders (never 404s). No dates.

import { notFound } from "next/navigation";
import Link from "next/link";
import { getProfileByHandle } from "@/lib/queries/profiles";
import { getPublicWatchedForCreator } from "@/lib/queries/watched";

export default async function PublicWatchedPage({
  params,
}: {
  params: Promise<{ handle: string }>;
}) {
  const { handle } = await params;
  const profile = await getProfileByHandle(handle);
  if (!profile || profile.is_stub || !profile.user_id) notFound();

  const items = await getPublicWatchedForCreator(profile.creator_id);
  const n = items.length;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-6 py-10">
      <div className="flex flex-col gap-2">
        <Link
          href={`/c/${profile.handle}`}
          className="text-body-sm text-moonbeem-ink-subtle transition-colors hover:text-moonbeem-pink"
        >
          ← {profile.display_name ?? `@${profile.handle}`}
        </Link>
        <h1 className="m-0 font-wordmark text-heading-lg text-moonbeem-ink">
          Watched
        </h1>
        <p className="m-0 text-body-sm text-moonbeem-ink-subtle">
          {n} {n === 1 ? "film" : "films"} · by @{profile.handle}
        </p>
      </div>

      {n === 0 ? (
        <p className="text-body-sm text-moonbeem-ink-subtle">
          No watched films yet.
        </p>
      ) : (
        <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6">
          {items.map((item) => {
            // Unmatched (title_id NULL) rows show raw_title (+ raw_year) text;
            // matched titles show the canonical name only (2D.1 rule).
            const label =
              item.title_id === null && item.raw_year
                ? `${item.title_name} (${item.raw_year})`
                : item.title_name;
            const poster = item.poster_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={item.poster_url}
                alt=""
                loading="lazy"
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center p-2 text-center text-caption text-moonbeem-ink-subtle">
                {label}
              </div>
            );
            const inner = (
              <>
                <div className="relative aspect-[2/3] w-full overflow-hidden rounded-md bg-moonbeem-navy/40">
                  {poster}
                </div>
                <span className="truncate text-caption text-moonbeem-ink-muted group-hover:text-moonbeem-pink">
                  {label}
                </span>
              </>
            );
            return item.title_slug ? (
              <Link
                key={item.id}
                href={`/t/${item.title_slug}`}
                prefetch={false}
                className="group flex flex-col gap-1"
              >
                {inner}
              </Link>
            ) : (
              <div key={item.id} className="group flex flex-col gap-1">
                {inner}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
