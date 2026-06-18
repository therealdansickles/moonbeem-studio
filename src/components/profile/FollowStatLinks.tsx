import Link from "next/link";
import { FOLLOW_STAT_CLASS } from "./follow-stat";

// Linkified follower/following byline. DIRECTIVE-FREE module (no "use client" /
// "use server") so it can be RENDERED by both the Server Component (ProfileView
// owner byline) and the Client island (FollowButton) — the same single-source
// shape the RSC hotfix established. The earlier bug was CALLING a client-module
// function from the server; rendering a neutral component across the boundary is
// legal. A pure render — counts + handle come in as props, so FollowButton can
// feed its LIVE optimistic count and the byline updates without a refresh.
//
// prefetch={false} on both links: these point at the high-density follower /
// following lists and must not prefetch. Text format (toLocaleString, singular/
// plural, " · " separator) is identical to the old followStatText string, just
// split into two clickable segments.
export default function FollowStatLinks({
  followers,
  following,
  handle,
}: {
  followers: number;
  following: number;
  handle: string;
}) {
  return (
    <p className={`m-0 ${FOLLOW_STAT_CLASS}`}>
      <Link
        href={`/c/${handle}/followers`}
        prefetch={false}
        className="transition-colors hover:text-moonbeem-pink hover:underline"
      >
        {followers.toLocaleString()} {followers === 1 ? "follower" : "followers"}
      </Link>
      {" · "}
      <Link
        href={`/c/${handle}/following`}
        prefetch={false}
        className="transition-colors hover:text-moonbeem-pink hover:underline"
      >
        {following.toLocaleString()} following
      </Link>
    </p>
  );
}
