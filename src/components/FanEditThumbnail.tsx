"use client";

import Image from "next/image";
import { motion } from "framer-motion";
import type { FanEdit } from "@/lib/queries/titles";
import { vibrate } from "@/lib/haptics";
import PlatformIcon from "./PlatformIcon";

type Props = {
  fanEdit: FanEdit;
  // Per-title poster fallback when fanEdit.thumbnail_url is null
  // (e.g. row was marked deleted_from_platform and the broken
  // upstream thumb was nulled out). Mirrors FanEditCard's
  // `fanEdit.thumbnail_url ?? fanEdit.title_poster_url` pattern.
  // The animate-pulse gradient only renders when BOTH are missing.
  titlePosterUrl?: string | null;
  eager?: boolean;
  onOpen: () => void;
};

const platformLabel: Record<FanEdit["platform"], string> = {
  tiktok: "TikTok",
  instagram: "Instagram",
  twitter: "X",
  youtube: "YouTube",
};

// Use a fixed per-platform aspect ratio in the grid — not the
// per-row fan_edit.aspect_ratio. Reason: mixed aspects inside one
// platform section produced visibly inconsistent heights even with
// align-items: start (a tall outlier still expands its row's
// max-content height; framer-motion's layoutId measurement also
// fights aspect-ratio on certain widths). Forcing uniformity here
// trades exact-fit for visual consistency; off-aspect images get
// cropped via object-cover. The DB aspect_ratio is preserved and
// can drive the modal player at native aspect.
function aspectFor(fe: FanEdit): string {
  switch (fe.platform) {
    case "tiktok":
    case "instagram":
      return "9 / 16";
    case "twitter":
    case "youtube":
      return "16 / 9";
  }
}

export default function FanEditThumbnail({
  fanEdit,
  titlePosterUrl,
  eager,
  onOpen,
}: Props) {
  const handle =
    fanEdit.creator_moonbeem_handle ??
    fanEdit.creator_handle_displayed ??
    "anon";
  // Mirror FanEditCard's fallback chain: thumbnail → title poster
  // → animate-pulse gradient (final). Rows marked
  // deleted_from_platform get thumbnail_url=NULL so they land on
  // the title-poster fallback rather than showing a loading shimmer.
  const renderSrc = fanEdit.thumbnail_url ?? titlePosterUrl ?? null;
  const hasImage = !!renderSrc;

  function handleClick() {
    vibrate(8);
    onOpen();
  }

  return (
    // Outer wrapper enforces the aspect ratio independently of
    // framer-motion's layoutId measurement. Without this split,
    // motion.button's layout calcs were collapsing the height.
    <div style={{ aspectRatio: aspectFor(fanEdit) }} className="relative w-full">
      <motion.button
        layoutId={`fan-edit-${fanEdit.id}`}
        type="button"
        onClick={handleClick}
        className="group absolute inset-0 block overflow-hidden rounded-xl bg-moonbeem-navy/40 transition-[transform,box-shadow] duration-200 ease-out hover:scale-[1.02] hover:shadow-[0_20px_40px_rgba(245,197,225,0.25)] active:scale-[0.98] focus:outline-none focus-visible:ring-2 focus-visible:ring-moonbeem-pink"
        aria-label={`Play fan edit by @${handle} on ${platformLabel[fanEdit.platform]}`}
      >
        {hasImage ? (
          <Image
            src={renderSrc!}
            alt=""
            fill
            sizes="(max-width: 768px) 50vw, 33vw"
            loading={eager ? "eager" : "lazy"}
            unoptimized={!!fanEdit.thumbnail_url}
            draggable={false}
            className="select-none object-cover"
          />
        ) : (
          <div className="absolute inset-0 animate-pulse bg-gradient-to-br from-moonbeem-navy via-moonbeem-black to-moonbeem-navy" />
        )}

        {/* Center play icon — fades in on hover (desktop) */}
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center opacity-0 transition-opacity duration-200 group-hover:opacity-100">
          <span
            aria-hidden="true"
            className="flex h-14 w-14 items-center justify-center rounded-full bg-black/40 text-2xl text-white/60 backdrop-blur-sm"
          >
            ▶
          </span>
        </div>

        {/* Bottom gradient + byline + platform pill */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 bg-gradient-to-t from-black/70 via-black/40 to-transparent p-3 pt-12">
          <span className="min-w-0 flex-1 truncate text-body-sm font-medium text-white">
            @{handle}
          </span>
          <span className="flex shrink-0 items-center gap-1 rounded-full border border-white/50 bg-transparent px-2 py-0.5 text-caption text-white">
            <PlatformIcon platform={fanEdit.platform} className="h-3 w-3" />
            {platformLabel[fanEdit.platform]}
          </span>
        </div>
      </motion.button>
    </div>
  );
}
