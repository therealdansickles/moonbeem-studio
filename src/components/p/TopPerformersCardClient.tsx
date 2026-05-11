"use client";

// Client wrapper for the partner-dashboard Top Performers card.
// Rendered from /p/[slug]/page.tsx (server component) which builds
// the modal-compatible row list and passes both alongside the
// display data. Click on a row → open the shared fan-edit modal
// at this surface's list + index, instead of navigating to the
// title page.
//
// GA fan_edit_click is intentionally NOT fired here — /p/[slug] is
// admin and excluded from the public tracking surface.

import Image from "next/image";
import Link from "next/link";
import PlatformIcon from "@/components/PlatformIcon";
import GrowthBadge from "@/components/p/GrowthBadge";
import InitialAvatar from "@/components/p/InitialAvatar";
import { rankTierClass } from "@/components/p/rankTier";
import { formatMetric } from "@/lib/format";
import {
  useFanEditModal,
  type FanEditForModal,
} from "@/components/FanEditModalProvider";

type SocialPlatform = "tiktok" | "instagram" | "twitter" | "youtube";

type Performer = {
  id: string;
  platform: SocialPlatform;
  view_count: number;
  thumbnail_url: string | null;
  creator_handle: string | null;
  growth_24h: number | null;
  growth_pct_24h: number | null;
};

type Props = {
  performers: Performer[];
  modalList: FanEditForModal[];
  titleSlug: string;
  titleName: string;
};

const platformLabel: Record<SocialPlatform, string> = {
  tiktok: "TikTok",
  instagram: "Instagram",
  twitter: "X",
  youtube: "YouTube",
};

export default function TopPerformersCardClient({
  performers,
  modalList,
  titleSlug,
  titleName,
}: Props) {
  const { open } = useFanEditModal();

  function openAt(i: number) {
    // track:false — same rationale as AllEditsTable. /p/[slug] is
    // admin; internal opens shouldn't increment partner-visible
    // counts or the outbound-CTA metric.
    open({
      fanEdits: modalList,
      index: i,
      titleSlug,
      titleName,
      track: false,
    });
  }

  // titleSlug not used today (rows open the modal in place rather
  // than jumping to /t/[slug]) — kept in scope so a future "open
  // title in new tab" affordance has access without a prop change.
  void titleSlug;

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
      <div className="flex items-center gap-3">
        <span className="rounded-full bg-moonbeem-pink/15 px-2.5 py-0.5 text-caption font-medium text-moonbeem-pink">
          Top performers
        </span>
        <span className="text-caption text-moonbeem-ink-subtle">
          by view count
        </span>
      </div>
      <ol className="mt-4 flex flex-col">
        {performers.map((fe, i) => {
          const rank = i + 1;
          return (
            <li
              key={fe.id}
              className="-mx-2 flex cursor-pointer items-center gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-white/[0.035]"
              onClick={() => openAt(i)}
            >
              <span
                className={`w-5 shrink-0 text-caption font-semibold tabular-nums ${rankTierClass(rank)}`}
              >
                {rank}
              </span>
              {/* Fan-edit thumbnail — kept (not replaced by avatar)
                  so two rows by the same creator stay distinguishable.
                  Wrapped in a button for the screen-reader hook + so
                  the click target is explicit; the outer row click
                  handler covers visual clicks. */}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  openAt(i);
                }}
                className="relative h-12 w-12 shrink-0 overflow-hidden rounded-lg bg-moonbeem-navy/40 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-moonbeem-pink"
                aria-label={`Open fan edit by @${fe.creator_handle ?? "anon"}`}
              >
                {fe.thumbnail_url
                  ? (
                    <Image
                      src={fe.thumbnail_url}
                      alt=""
                      fill
                      sizes="48px"
                      unoptimized
                      className="object-cover"
                    />
                  )
                  : null}
              </button>
              {/* Creator avatar — 32px gradient-initial fallback for
                  stub creators. Real avatars land when public_creators
                  exposes avatar_url (followup memory). */}
              {fe.creator_handle && <InitialAvatar handle={fe.creator_handle} />}
              <div className="flex min-w-0 flex-1 flex-col">
                {fe.creator_handle
                  ? (
                    <Link
                      href={`/c/${fe.creator_handle}`}
                      onClick={(e) => e.stopPropagation()}
                      className="truncate text-body-sm font-medium text-moonbeem-ink hover:text-moonbeem-pink hover:underline"
                    >
                      @{fe.creator_handle}
                    </Link>
                  )
                  : (
                    <span className="text-body-sm text-moonbeem-ink-subtle">
                      @anon
                    </span>
                  )}
                <span className="flex items-center gap-1.5 text-caption text-moonbeem-ink-subtle">
                  <PlatformIcon platform={fe.platform} className="h-3 w-3" />
                  {platformLabel[fe.platform]}
                </span>
              </div>
              <div className="flex flex-col items-end">
                <span className="text-body-sm font-semibold tabular-nums text-moonbeem-ink">
                  {formatMetric(fe.view_count)}
                </span>
                <GrowthBadge delta={fe.growth_24h} pct={fe.growth_pct_24h} />
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
