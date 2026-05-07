"use client";

import Image from "next/image";
import { motion } from "framer-motion";
import type { FanEdit } from "@/lib/queries/titles";
import PlatformIcon from "./PlatformIcon";

type Props = {
  fanEdit: FanEdit;
  eager?: boolean;
  onOpen: () => void;
};

const platformLabel: Record<FanEdit["platform"], string> = {
  tiktok: "TikTok",
  instagram: "Instagram",
  twitter: "X",
  youtube: "YouTube",
};

// 9:16 default for video-vertical (TikTok/Reels are most common).
// 16:9 fallback specifically for YouTube. Otherwise we follow the
// extracted aspect_ratio from view-tracking. The CSS `aspect-ratio`
// property accepts "w / h" so we transform "9:16" → "9 / 16".
function aspectFor(fe: FanEdit): string {
  if (fe.aspect_ratio) {
    return fe.aspect_ratio.replace(":", " / ");
  }
  return fe.platform === "youtube" ? "16 / 9" : "9 / 16";
}

export default function FanEditThumbnail({ fanEdit, eager, onOpen }: Props) {
  const handle =
    fanEdit.creator_moonbeem_handle ??
    fanEdit.creator_handle_displayed ??
    "anon";
  const hasThumb = !!fanEdit.thumbnail_url;

  return (
    <motion.button
      layoutId={`fan-edit-${fanEdit.id}`}
      type="button"
      onClick={onOpen}
      style={{ aspectRatio: aspectFor(fanEdit) }}
      className="group relative block w-full overflow-hidden rounded-xl bg-moonbeem-navy/40 transition-[transform,box-shadow] duration-200 ease-out hover:scale-[1.02] hover:shadow-[0_20px_40px_rgba(245,197,225,0.25)] active:scale-[0.98] focus:outline-none focus-visible:ring-2 focus-visible:ring-moonbeem-pink"
      aria-label={`Play fan edit by @${handle} on ${platformLabel[fanEdit.platform]}`}
    >
      {hasThumb ? (
        <Image
          src={fanEdit.thumbnail_url!}
          alt=""
          fill
          sizes="(max-width: 768px) 50vw, 33vw"
          loading={eager ? "eager" : "lazy"}
          unoptimized
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
  );
}
