"use client";

import { useCallback, useEffect, useRef } from "react";
import Link from "next/link";
import { AnimatePresence, motion, type PanInfo } from "framer-motion";
import { InstagramEmbed, TikTokEmbed, XEmbed } from "react-social-media-embed";
import type { FanEdit } from "@/lib/queries/titles";
import PlatformIcon from "./PlatformIcon";

type Props = {
  // Full list, already sorted view_count DESC. Arrow-nav cycles through
  // this list across all platforms.
  fanEdits: FanEdit[];
  // -1 when closed; otherwise index into fanEdits.
  openIndex: number;
  titleSlug: string;
  titleName: string;
  onClose: () => void;
  onNavigate: (newIndex: number) => void;
};

const platformLabel: Record<FanEdit["platform"], string> = {
  tiktok: "TikTok",
  instagram: "Instagram",
  twitter: "X",
  youtube: "YouTube",
};

const SWIPE_DISMISS_THRESHOLD = 120;

export default function FanEditModal({
  fanEdits,
  openIndex,
  titleSlug,
  titleName,
  onClose,
  onNavigate,
}: Props) {
  const isOpen = openIndex >= 0 && openIndex < fanEdits.length;
  const fanEdit = isOpen ? fanEdits[openIndex] : null;

  const closeRef = useRef<HTMLButtonElement | null>(null);

  // Body scroll lock + ESC/arrow keys + focus management. All scoped
  // to "while open."
  useEffect(() => {
    if (!isOpen) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowRight" && openIndex < fanEdits.length - 1) {
        e.preventDefault();
        onNavigate(openIndex + 1);
      } else if (e.key === "ArrowLeft" && openIndex > 0) {
        e.preventDefault();
        onNavigate(openIndex - 1);
      }
    }
    document.addEventListener("keydown", onKey);

    // Move initial focus to the close button (predictable target,
    // accessible-correct for dialogs).
    closeRef.current?.focus();

    return () => {
      document.body.style.overflow = prevOverflow;
      document.removeEventListener("keydown", onKey);
    };
  }, [isOpen, openIndex, fanEdits.length, onClose, onNavigate]);

  const onDragEnd = useCallback(
    (_e: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
      if (info.offset.y > SWIPE_DISMISS_THRESHOLD) onClose();
    },
    [onClose],
  );

  return (
    <AnimatePresence>
      {isOpen && fanEdit && (
        <ModalContent
          fanEdit={fanEdit}
          openIndex={openIndex}
          total={fanEdits.length}
          titleSlug={titleSlug}
          titleName={titleName}
          onClose={onClose}
          onPrev={() => onNavigate(openIndex - 1)}
          onNext={() => onNavigate(openIndex + 1)}
          onDragEnd={onDragEnd}
          closeRef={closeRef}
        />
      )}
    </AnimatePresence>
  );
}

type ContentProps = {
  fanEdit: FanEdit;
  openIndex: number;
  total: number;
  titleSlug: string;
  titleName: string;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
  onDragEnd: (
    e: MouseEvent | TouchEvent | PointerEvent,
    info: PanInfo,
  ) => void;
  closeRef: React.RefObject<HTMLButtonElement | null>;
};

function ModalContent({
  fanEdit,
  openIndex,
  total,
  titleSlug,
  titleName,
  onClose,
  onPrev,
  onNext,
  onDragEnd,
  closeRef,
}: ContentProps) {
  const handle =
    fanEdit.creator_moonbeem_handle ??
    fanEdit.creator_handle_displayed ??
    "anon";
  const handleHasLink = !!fanEdit.creator_moonbeem_handle;
  const bylineId = `fan-edit-modal-byline-${fanEdit.id}`;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={bylineId}
      className="fixed inset-0 z-50 flex items-stretch justify-center md:items-center"
    >
      <motion.div
        key="backdrop"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.22, ease: "easeOut" }}
        onClick={onClose}
        className="absolute inset-0 bg-black/85 backdrop-blur-md"
      />

      <motion.div
        key="dialog"
        layoutId={`fan-edit-${fanEdit.id}`}
        drag="y"
        dragConstraints={{ top: 0, bottom: 0 }}
        dragElastic={{ top: 0, bottom: 0.5 }}
        onDragEnd={onDragEnd}
        className="relative z-10 flex h-full w-full flex-col bg-moonbeem-black md:h-auto md:max-h-[90vh] md:w-auto md:max-w-[440px] md:overflow-hidden md:rounded-2xl md:border md:border-white/10 md:shadow-2xl md:shadow-black/60"
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <Link
              href={`/t/${titleSlug}`}
              className="truncate text-caption text-moonbeem-ink-subtle hover:text-moonbeem-ink"
            >
              {titleName}
            </Link>
            {handleHasLink ? (
              <Link
                id={bylineId}
                href={`/c/${fanEdit.creator_moonbeem_handle}`}
                prefetch={false}
                className="truncate text-body-sm font-medium text-moonbeem-ink hover:text-moonbeem-pink hover:underline"
              >
                @{handle}
              </Link>
            ) : (
              <span
                id={bylineId}
                className="truncate text-body-sm font-medium text-moonbeem-ink"
              >
                @{handle}
              </span>
            )}
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md px-2 py-1 text-body text-moonbeem-ink-subtle hover:text-moonbeem-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-moonbeem-pink"
          >
            ✕
          </button>
        </div>

        {/* Body — lazy embed (only mounts while modal is open) */}
        <div className="flex flex-1 items-start justify-center overflow-y-auto bg-moonbeem-navy/20 p-3">
          <div className="w-full max-w-[400px]">
            <EmbedFor fanEdit={fanEdit} />
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 border-t border-white/10 px-4 py-3">
          <a
            href={fanEdit.embed_url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-body-sm text-moonbeem-ink hover:text-moonbeem-pink"
          >
            <PlatformIcon
              platform={fanEdit.platform}
              className="h-3.5 w-3.5"
            />
            <span>View on {platformLabel[fanEdit.platform]}</span>
          </a>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={onPrev}
              disabled={openIndex <= 0}
              aria-label="Previous fan edit"
              className="rounded-md px-2 py-1 text-body text-moonbeem-ink hover:text-moonbeem-pink disabled:cursor-not-allowed disabled:opacity-30 focus:outline-none focus-visible:ring-2 focus-visible:ring-moonbeem-pink"
            >
              ←
            </button>
            <span className="text-caption tabular-nums text-moonbeem-ink-subtle">
              {openIndex + 1} / {total}
            </span>
            <button
              type="button"
              onClick={onNext}
              disabled={openIndex >= total - 1}
              aria-label="Next fan edit"
              className="rounded-md px-2 py-1 text-body text-moonbeem-ink hover:text-moonbeem-pink disabled:cursor-not-allowed disabled:opacity-30 focus:outline-none focus-visible:ring-2 focus-visible:ring-moonbeem-pink"
            >
              →
            </button>
          </div>
        </div>
      </motion.div>
    </div>
  );
}

function EmbedFor({ fanEdit }: { fanEdit: FanEdit }) {
  switch (fanEdit.platform) {
    case "instagram":
      return (
        <InstagramEmbed
          url={fanEdit.embed_url}
          width="100%"
          retryDelay={1000}
          placeholderDisabled
        />
      );
    case "tiktok":
      return <TikTokEmbed url={fanEdit.embed_url} width="100%" />;
    case "twitter":
      return <XEmbed url={fanEdit.embed_url} width="100%" />;
    default:
      return (
        <div className="py-12 text-center text-body-sm text-moonbeem-ink-subtle">
          Embed not available for this platform.
        </div>
      );
  }
}
