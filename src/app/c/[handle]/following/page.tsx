// Step 4/5 — public following list. Sibling of followers/page.tsx; same anatomy,
// reads getFollowingOfCreator (who X follows). notFound() a missing/stub/
// unclaimed SUBJECT; ROWS may be stubs (read does NOT filter is_stub). Header
// count from the denormalized profile.following_count (never count(*)).

import { notFound } from "next/navigation";
import Link from "next/link";
import { getProfileByHandle } from "@/lib/queries/profiles";
import { getFollowingOfCreator } from "@/lib/follows/server";
import CreatorRow from "@/components/profile/CreatorRow";

const PAGE_SIZE = 30;

export default async function FollowingPage({
  params,
  searchParams,
}: {
  params: Promise<{ handle: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  const { handle } = await params;
  const { page: pageParam } = await searchParams;
  const profile = await getProfileByHandle(handle);
  if (!profile || profile.is_stub || !profile.user_id) notFound();

  const page = Math.max(1, Number.parseInt(pageParam ?? "1", 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;
  const rows = await getFollowingOfCreator(profile.creator_id, {
    limit: PAGE_SIZE,
    offset,
  });

  const total = profile.following_count;
  const hasPrev = page > 1;
  const hasNext = rows.length === PAGE_SIZE;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-6 py-10">
      <div className="flex flex-col gap-2">
        <Link
          href={`/c/${profile.handle}`}
          prefetch={false}
          className="text-body-sm text-moonbeem-ink-subtle transition-colors hover:text-moonbeem-pink"
        >
          ← {profile.display_name ?? `@${profile.handle}`}
        </Link>
        <h1 className="m-0 font-wordmark text-heading-lg text-moonbeem-ink">
          Following
        </h1>
        <p className="m-0 text-body-sm text-moonbeem-ink-subtle">
          {total.toLocaleString()} following · @{profile.handle}
        </p>
      </div>

      {rows.length === 0 ? (
        <p className="text-body-sm text-moonbeem-ink-subtle">
          Not following anyone yet.
        </p>
      ) : (
        <div className="flex flex-col gap-1">
          {rows.map((c) => (
            <CreatorRow key={c.creatorId} creator={c} />
          ))}
        </div>
      )}

      {(hasPrev || hasNext) && (
        <div className="flex items-center justify-between border-t border-white/10 pt-4">
          {hasPrev ? (
            <Link
              href={`/c/${profile.handle}/following?page=${page - 1}`}
              prefetch={false}
              className="text-body-sm text-moonbeem-ink-subtle transition-colors hover:text-moonbeem-pink"
            >
              ← Previous
            </Link>
          ) : (
            <span />
          )}
          {hasNext ? (
            <Link
              href={`/c/${profile.handle}/following?page=${page + 1}`}
              prefetch={false}
              className="text-body-sm text-moonbeem-ink-subtle transition-colors hover:text-moonbeem-pink"
            >
              Next →
            </Link>
          ) : (
            <span />
          )}
        </div>
      )}
    </div>
  );
}
