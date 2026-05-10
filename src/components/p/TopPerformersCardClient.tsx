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
      <ol className="mt-4 flex flex-col divide-y divide-white/5">
        {performers.map((fe, i) => (
          <li key={fe.id} className="flex items-center gap-3 py-3">
            <span className="w-5 shrink-0 text-caption tabular-nums text-moonbeem-ink-subtle">
              {i + 1}
            </span>
            <button
              type="button"
              onClick={() => openAt(i)}
              className="relative h-12 w-12 shrink-0 overflow-hidden rounded-md bg-moonbeem-navy/40 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-moonbeem-pink"
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
            <div className="flex min-w-0 flex-1 flex-col">
              {fe.creator_handle
                ? (
                  <Link
                    href={`/c/${fe.creator_handle}`}
                    className="truncate text-body-sm font-medium text-moonbeem-ink hover:text-moonbeem-pink"
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
              <button
                type="button"
                onClick={() => openAt(i)}
                className="text-body-sm font-semibold tabular-nums text-moonbeem-ink cursor-pointer hover:text-moonbeem-pink"
              >
                {formatMetric(fe.view_count)}
              </button>
              <GrowthBadge delta={fe.growth_24h} pct={fe.growth_pct_24h} />
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
