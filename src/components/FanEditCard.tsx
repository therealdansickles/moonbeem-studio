"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { motion, useReducedMotion } from "framer-motion";
import type { FanEditWithTitle } from "@/lib/queries/titles";
import { useFanEditModal } from "./FanEditModalProvider";
import { trackFanEditClick } from "@/lib/analytics/track";
import PlatformIcon from "./PlatformIcon";
import { isR2ThumbnailUrl } from "@/lib/fan-edits/thumbnail-url";

type Props = {
  fanEdit: FanEditWithTitle;
  // Optional carousel context — when this card sits in a
  // FanEditCarousel, the parent passes the full list and this
  // card's index so the modal can arrow-nav across siblings.
  // Without these, the modal opens with a single-item list (legacy
  // standalone-card behavior). The homepage Recent Edits +
  // Trending Fan Edits carousels are CROSS-TITLE — each sibling
  // can belong to a different title — so when carousel context is
  // present the modal byline-title link is suppressed (handled by
  // passing empty titleSlug/Name) to avoid mid-nav byline drift.
  siblings?: FanEditWithTitle[];
  siblingIndex?: number;
};

export default function FanEditCard({
  fanEdit,
  siblings,
  siblingIndex,
}: Props) {
  const router = useRouter();
  const { open } = useFanEditModal();
  // Reduced-motion gate: layoutId shared-layout transitions are
  // layout animations, NOT covered by framer-motion's variant
  // reduced-motion handling. Setting layoutId to undefined under
  // reduced-motion disables the modal-zoom pairing — the modal
  // mounts flat (backdrop fade only).
  const reduce = useReducedMotion();
  // Prefer the canonical moonbeem_handle for both display and the
  // /c/[handle] link target. Falls back to the platform-side handle
  // for the small set of legacy null-creator rows.
  const moonbeemHandle = fanEdit.creator_moonbeem_handle;
  const displayHandle =
    moonbeemHandle ?? fanEdit.creator_handle_displayed ?? null;

  function openModal() {
    trackFanEditClick({
      title_id: fanEdit.title_id,
      fan_edit_id: fanEdit.id,
      platform: fanEdit.platform,
      creator_handle:
        fanEdit.creator_moonbeem_handle ??
        fanEdit.creator_handle_displayed ??
        null,
    });
    const hasCarousel =
      Array.isArray(siblings) &&
      typeof siblingIndex === "number" &&
      siblingIndex >= 0 &&
      siblingIndex < siblings.length;
    // Modal byline derives from per-fanEdit title_slug/title_name
    // on each item (FanEditWithTitle already carries them), so the
    // byline tracks the current card during arrow-nav across
    // cross-title carousels. Top-level titleSlug/titleName are
    // still passed for back-compat with any legacy reader.
    if (hasCarousel) {
      open({
        fanEdits: siblings!,
        index: siblingIndex!,
        titleSlug: fanEdit.title_slug,
        titleName: fanEdit.title_name,
      });
    } else {
      open({
        fanEdits: [fanEdit],
        index: 0,
        titleSlug: fanEdit.title_slug,
        titleName: fanEdit.title_name,
      });
    }
  }

  // Both can be null (a deleted-from-platform fan_edit on a poster-less
  // title), so guard before rendering — <Image src={null}> breaks the rail.
  // Only an R2-hosted thumbnail is trusted; null/external/expired urls fall
  // back to the title poster.
  const thumbSrc =
    (isR2ThumbnailUrl(fanEdit.thumbnail_url) ? fanEdit.thumbnail_url : null) ??
    fanEdit.title_poster_url;

  return (
    // Outer wrapper enforces aspect-ratio independently of the
    // motion.button's layoutId measurement — same split pattern
    // documented at FanEditThumbnail.tsx (aspect-ratio on a
    // layoutId element collapses height during layout measurement).
    <div className="relative aspect-[3/4] w-full">
    <motion.button
      layoutId={reduce ? undefined : `fan-edit-${fanEdit.id}`}
      type="button"
      onClick={openModal}
      className="group absolute inset-0 block cursor-pointer overflow-hidden rounded-xl bg-moonbeem-navy/40 text-left transition-[transform,box-shadow] duration-300 ease-[cubic-bezier(0.25,1,0.5,1)] hover:scale-[1.03] hover:shadow-[0_20px_40px_rgba(245,197,225,0.3)] focus:outline-none focus-visible:ring-2 focus-visible:ring-moonbeem-pink"
    >
      {thumbSrc ? (
        <Image
          src={thumbSrc}
          alt={
            fanEdit.thumbnail_url
              ? `${fanEdit.title_name} fan edit by ${displayHandle ?? "@anon"}`
              : `${fanEdit.title_name} poster`
          }
          fill
          sizes="(max-width: 768px) 75vw, 280px"
          draggable={false}
          className="select-none object-cover"
          unoptimized={!!fanEdit.thumbnail_url}
        />
      ) : (
        <div
          aria-hidden
          className="absolute inset-0 bg-gradient-to-br from-moonbeem-navy to-black"
        />
      )}

      <div className="absolute left-3 top-3 flex h-7 w-7 items-center justify-center rounded-full bg-black/60 text-moonbeem-ink backdrop-blur-sm">
        <PlatformIcon platform={fanEdit.platform} className="h-4 w-4" />
      </div>

      <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/40 to-transparent p-3 pt-12">
        <p className="text-body-sm font-medium text-moonbeem-ink leading-tight line-clamp-2">
          {fanEdit.title_name}
        </p>
        <p className="mt-0.5 text-caption text-moonbeem-ink-subtle truncate">
          by{" "}
          {moonbeemHandle ? (
            // Byline link still goes to /c/[handle]; click-stop
            // prevents the outer button's modal-open from firing.
            <span
              role="link"
              tabIndex={0}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                router.push(`/c/${moonbeemHandle}`);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  e.stopPropagation();
                  router.push(`/c/${moonbeemHandle}`);
                }
              }}
              className="pointer-events-auto cursor-pointer hover:text-moonbeem-pink hover:underline"
            >
              @{displayHandle}
            </span>
          ) : (
            <span>@{displayHandle ?? "anon"}</span>
          )}
        </p>
      </div>
    </motion.button>
    </div>
  );
}
