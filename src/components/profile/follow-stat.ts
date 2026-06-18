// Neutral (no "use client" / "use server") helpers for the follower/following
// stat byline. Importable from BOTH the Server Component (ProfileView's owner
// byline) and the Client island (FollowButton's optimistic byline) so the two
// render byte-identically from one source. Extracted out of FollowButton.tsx
// (a "use client" module) because a Server Component calling a client-module
// export crosses the RSC boundary and throws — that was the owner self-view bug.

// Shared so the static owner byline (ProfileView) is byte-identical.
export const FOLLOW_STAT_CLASS = "text-caption text-moonbeem-ink-subtle";

export function followStatText(followers: number, following: number): string {
  return `${followers.toLocaleString()} ${
    followers === 1 ? "follower" : "followers"
  } · ${following.toLocaleString()} following`;
}
