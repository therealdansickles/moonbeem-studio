// Step 4/5 — public followers list. Mirrors the watched sub-page anatomy:
// resolve the handle to a creator (anon SSR), notFound() a missing/stub/
// unclaimed SUBJECT (same condition the /c/[handle] profile page uses to decide
// a handle is a real profile — note that page renders an "unclaimed" message
// rather than 404, but the follower byline that links here only exists on
// claimed profiles, so 404 is the honest behavior for a direct hit on a stub).
// The ROWS, however, may be stubs — the read does NOT filter on is_stub.
//
// Header count comes from the denormalized profile.follower_count (NEVER
// count(*)). Pagination: offset/limit page size 30, ?page=, prev/next.

import { notFound } from "next/navigation";
import Link from "next/link";
import { getProfileByHandle } from "@/lib/queries/profiles";
import { getFollowersOfCreator } from "@/lib/follows/server";
import CreatorRow from "@/components/profile/CreatorRow";

const PAGE_SIZE = 30;

export default async function FollowersPage({
  params,
  searchParams,
}: {
  params: Promise<{ handle: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  const { handle } = await params;
  const { page: pageParam } = await searchParams;
  const profile = await getProfileByHandle(handle);
  // Only a genuinely missing/deleted handle 404s (getProfileByHandle returns
  // null when no live creator row matches). A STUB/unclaimed subject renders
  // 200 WITH the list — a stub seeing their waiting followers is the claim
  // incentive. Parity with /c/[handle], which shows the unclaimed framing for a
  // stub. The rows are NEVER gated behind the unclaimed state.
  if (!profile) notFound();
  const isUnclaimed = profile.is_stub || !profile.user_id;

  const page = Math.max(1, Number.parseInt(pageParam ?? "1", 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;
  const rows = await getFollowersOfCreator(profile.creator_id, {
    limit: PAGE_SIZE,
    offset,
  });

  // Denormalized count for the header — never count(*).
  const total = profile.follower_count;
  const hasPrev = page > 1;
  // A full page implies there may be more — avoids a count query.
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
          Followers
        </h1>
        <p className="m-0 text-body-sm text-moonbeem-ink-subtle">
          {total.toLocaleString()} {total === 1 ? "follower" : "followers"} · @
          {profile.handle}
        </p>
      </div>

      {/* Unclaimed framing — mirrors the /c/[handle] stub copy (ProfileView's
          null branch), but ADDITIVE: the follower rows still render beneath it.
          A stub with followers seeing them is the claim incentive. */}
      {isUnclaimed && (
        <div className="rounded-lg border border-moonbeem-pink/30 bg-moonbeem-pink/10 p-4">
          <p className="m-0 text-body text-moonbeem-ink-muted">
            This handle isn&apos;t claimed yet.
          </p>
          <p className="m-0 mt-1 text-body-sm text-moonbeem-ink-subtle">
            If you&apos;re @{profile.handle}, sign up to claim it.
          </p>
          <Link
            href="/login"
            className="mt-4 inline-block rounded-md bg-moonbeem-pink px-4 py-2 text-body-sm font-semibold text-moonbeem-navy transition-opacity hover:opacity-90"
          >
            Sign up
          </Link>
        </div>
      )}

      {rows.length === 0 ? (
        <p className="text-body-sm text-moonbeem-ink-subtle">
          No followers yet.
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
              href={`/c/${profile.handle}/followers?page=${page - 1}`}
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
              href={`/c/${profile.handle}/followers?page=${page + 1}`}
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
