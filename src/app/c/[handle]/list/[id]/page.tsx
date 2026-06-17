// Phase 1D — public list detail (read-only). Resolves the handle to a creator,
// then the public list. A private / not-this-creator's / missing list is an
// RLS-empty read → 404. Mirrors the profile page's data idioms (anon SSR).

import { notFound } from "next/navigation";
import Link from "next/link";
import { getCurrentProfile } from "@/lib/dal";
import { getProfileByHandle } from "@/lib/queries/profiles";
import { getPublicListDetail } from "@/lib/queries/lists";

export default async function PublicListPage({
  params,
}: {
  params: Promise<{ handle: string; id: string }>;
}) {
  const { handle, id } = await params;
  const profile = await getProfileByHandle(handle);
  if (!profile || profile.is_stub || !profile.user_id) notFound();

  // Viewer auth, fetched before the list so posters link to /t/[slug] when
  // reachable by THIS viewer: public titles for anyone, plus non-public catalog
  // titles when the viewer is signed in (Step 1). Logged-out viewers keep
  // public-only links.
  const currentUser = await getCurrentProfile();

  const list = await getPublicListDetail(profile.creator_id, id, !!currentUser);
  if (!list) notFound();

  // Owner doorway: the signed-in viewer who owns this list gets an "Edit list"
  // link into the /me builder. Read-only for everyone else (idiom mirrors the
  // profile page: current user's id === the profile's user_id).
  const isOwner = currentUser?.userId === profile.user_id;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-6 py-10">
      <div className="flex flex-col gap-2">
        <Link
          href={`/c/${profile.handle}`}
          className="text-body-sm text-moonbeem-ink-subtle transition-colors hover:text-moonbeem-pink"
        >
          ← {profile.display_name ?? `@${profile.handle}`}
        </Link>
        <div className="flex items-center gap-3">
          <h1 className="m-0 font-wordmark text-heading-lg text-moonbeem-ink">
            {list.name}
          </h1>
          {list.kind === "watchlist" && (
            <span className="rounded-full border border-moonbeem-pink/30 bg-moonbeem-pink/10 px-2 py-0.5 text-caption text-moonbeem-pink">
              Watchlist
            </span>
          )}
        </div>
        {list.description && (
          <p className="m-0 max-w-prose whitespace-pre-line text-body text-moonbeem-ink">
            {list.description}
          </p>
        )}
        <p className="m-0 text-body-sm text-moonbeem-ink-subtle">
          {list.item_count} {list.item_count === 1 ? "film" : "films"} · by @
          {profile.handle}
        </p>
        {isOwner && (
          <Link
            href={`/me/lists/${list.id}`}
            className="w-fit text-body-sm font-medium text-moonbeem-pink hover:opacity-90"
          >
            Edit list →
          </Link>
        )}
      </div>

      {list.items.length === 0 ? (
        <p className="text-body-sm text-moonbeem-ink-subtle">
          This list is empty.
        </p>
      ) : (
        <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6">
          {list.items.map((item) => {
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
                {item.title_name}
              </div>
            );
            const inner = (
              <>
                <div className="relative aspect-[2/3] w-full overflow-hidden rounded-md bg-moonbeem-navy/40">
                  {poster}
                </div>
                <span className="truncate text-caption text-moonbeem-ink-muted group-hover:text-moonbeem-pink">
                  {item.title_name}
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
