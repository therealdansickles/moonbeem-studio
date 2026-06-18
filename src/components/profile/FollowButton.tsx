"use client";

// Follow feature — Step 3: the Follow button + its adjacent follower/following
// stat line on /c/[handle]. Client child of the server profile page, rendered
// ONLY for non-owners (the page omits this island entirely when isOwner, so
// own-profile hiding is decided server-side). Owners get a static server byline
// instead — see ProfileView.
//
// Five states, resolved server-side and passed in (no round trip on load, no
// probe on click for anon/no_creator):
//   own profile → this island is NOT rendered at all (server-gated)
//   "anon"      → "Follow"; click opens the auth GateModal (sign-in)
//   "no_creator"→ "Follow"; click routes to /onboarding/handle (conversion)
//   "ready" + not following → "Follow"; click follows (optimistic)
//   "ready" + following     → "Following"; click unfollows (optimistic)
//
// The stat line and button share one optimistic follower count so the count
// adjusts the instant the button flips. followingCount is this profile's own
// following total and is unaffected by the viewer's action, so it stays static.
// Mirrors TitleRatingControl: optimistic flip + inline error revert (no toast
// library in the repo), GateModal for auth_required.

import { useState } from "react";
import { useRouter } from "next/navigation";
import GateModal from "@/components/gating/GateModal";
import { fetchJson, FetchJsonError } from "@/lib/fetch-json";
import type { FollowState } from "@/lib/follows/server";

// Shared so the static owner byline (ProfileView) is byte-identical.
export const FOLLOW_STAT_CLASS = "text-caption text-moonbeem-ink-subtle";

export function followStatText(followers: number, following: number): string {
  return `${followers.toLocaleString()} ${
    followers === 1 ? "follower" : "followers"
  } · ${following.toLocaleString()} following`;
}

type FollowResponse = {
  ok: boolean;
  isFollowing?: boolean;
  followerCount?: number;
  reason?: string;
};

export default function FollowButton({
  targetCreatorId,
  initialIsFollowing,
  initialFollowerCount,
  followingCount,
  followState,
  returnTo,
}: {
  targetCreatorId: string;
  initialIsFollowing: boolean;
  initialFollowerCount: number;
  followingCount: number;
  followState: FollowState;
  returnTo: string;
}) {
  const router = useRouter();
  const [isFollowing, setIsFollowing] = useState(initialIsFollowing);
  const [count, setCount] = useState(initialFollowerCount);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gateOpen, setGateOpen] = useState(false);

  async function onClick() {
    if (pending) return; // debounce fast double-clicks (server is idempotent anyway)

    // Anon / unclaimed are known up front — route immediately, no fetch.
    if (followState === "anon") {
      setGateOpen(true);
      return;
    }
    if (followState === "no_creator") {
      router.push(`/onboarding/handle?next=${encodeURIComponent(returnTo)}`);
      return;
    }

    const nextFollowing = !isFollowing;
    const prevFollowing = isFollowing;
    const prevCount = count;

    // Optimistic flip + immediate count adjust.
    setIsFollowing(nextFollowing);
    setCount((c) => Math.max(0, c + (nextFollowing ? 1 : -1)));
    setError(null);
    setPending(true);

    try {
      const data = await fetchJson<FollowResponse>("/api/follows", {
        method: nextFollowing ? "POST" : "DELETE",
        body: { target_creator_id: targetCreatorId },
      });
      // Settle on server truth (read-back of the denormalized column).
      if (typeof data.isFollowing === "boolean") setIsFollowing(data.isFollowing);
      if (typeof data.followerCount === "number") setCount(data.followerCount);
    } catch (err) {
      // Roll back the optimistic flip first, then branch.
      setIsFollowing(prevFollowing);
      setCount(prevCount);
      if (err instanceof FetchJsonError) {
        const reason =
          err.payload && typeof err.payload === "object"
            ? (err.payload as { reason?: string }).reason
            : undefined;
        // Session changed since load — route rather than leave a stale button.
        if (reason === "no_creator") {
          router.push(`/onboarding/handle?next=${encodeURIComponent(returnTo)}`);
          return;
        }
        if (reason === "auth_required" || err.status === 401) {
          setGateOpen(true);
          return;
        }
        setError(err.userMessage);
      } else {
        setError("Something went wrong.");
      }
    } finally {
      setPending(false);
    }
  }

  const label = followState === "ready" && isFollowing ? "Following" : "Follow";
  // "Following" reads as a quiet, already-done state; "Follow" is the primary
  // pink CTA. Hover on "Following" hints the unfollow affordance.
  const className =
    followState === "ready" && isFollowing
      ? "rounded-md border border-white/15 bg-white/5 px-4 py-1.5 text-body-sm font-semibold text-moonbeem-ink-muted transition-colors hover:border-moonbeem-magenta hover:text-moonbeem-magenta disabled:opacity-50"
      : "rounded-md bg-moonbeem-pink px-4 py-1.5 text-body-sm font-semibold text-moonbeem-navy transition-opacity hover:opacity-90 disabled:opacity-50";

  return (
    <div className="flex shrink-0 flex-col items-center gap-1.5 sm:items-end">
      <button
        type="button"
        onClick={() => void onClick()}
        disabled={pending}
        aria-pressed={followState === "ready" ? isFollowing : undefined}
        className={className}
      >
        {label}
      </button>
      {/* Stat line — plain text now; Step 4/5 turns these into list links. */}
      <p className={`m-0 ${FOLLOW_STAT_CLASS}`}>
        {followStatText(count, followingCount)}
      </p>
      {error && (
        <p className="m-0 text-body-sm text-moonbeem-magenta">{error}</p>
      )}
      {followState === "anon" && (
        <GateModal
          open={gateOpen}
          onClose={() => setGateOpen(false)}
          reason="auth_required"
          returnTo={returnTo}
        />
      )}
    </div>
  );
}
