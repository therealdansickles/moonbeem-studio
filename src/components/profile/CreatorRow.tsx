import Link from "next/link";
import AvatarCircle from "./AvatarCircle";
import type { CreatorRow as CreatorRowData } from "@/lib/follows/server";

// A single navigational row in a follower / following list. Plain server
// component (no client island — these lists are high-density link surfaces, so
// every row is just a Link). prefetch={false} is REQUIRED here: a follower list
// is exactly the surface the 58-fan-edit prefetch storm came from, and prefetch
// is not inherited — it must be set explicitly on every creator link.
//
// Stub rows (no linked user) arrive with displayName/avatarUrl null: the name
// falls back to the handle and AvatarCircle renders initials. They are normal,
// un-badged rows by design.
export default function CreatorRow({ creator }: { creator: CreatorRowData }) {
  const name = creator.displayName ?? creator.handle;
  return (
    <Link
      href={`/c/${creator.handle}`}
      prefetch={false}
      className="flex items-center gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-white/5"
    >
      <AvatarCircle
        avatarUrl={creator.avatarUrl}
        displayName={creator.displayName}
        handle={creator.handle}
        size={44}
        className="shrink-0"
      />
      <div className="min-w-0">
        <p className="m-0 truncate text-body-sm font-medium text-moonbeem-ink">
          {name}
        </p>
        <p className="m-0 truncate text-caption text-moonbeem-ink-subtle">
          @{creator.handle}
        </p>
      </div>
    </Link>
  );
}
