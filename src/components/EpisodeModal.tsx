"use client";

import { useCallback, useEffect } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { InstagramEmbed } from "react-social-media-embed";
import type { TitleEpisode } from "@/lib/queries/titles";
import EpisodePlayGate from "@/components/EpisodePlayGate";

// Standalone episode player. Two render paths, branched on episode.source:
//   - instagram: tokenless public IG embed (unchanged from before).
//   - mux: DRM playback behind <EpisodePlayGate> — a still + play button that
//     mounts the player (and therefore mints the token) ONLY on an explicit play
//     click. The modal chrome (scroll-lock, Escape, overlay, close) is unchanged.
//     FanEditModal is left entirely untouched.
//
// ⚠️ MONEY-ADJACENT — DO NOT mount <MuxEpisodePlayer> directly here again. Until
// 2026-07-14 this modal rendered the player the instant it opened, which POSTed
// the playback-token and STAMPED entitlements.first_played_at — starting the
// viewer's 48-hour rental clock on a modal open, before a single frame played (the
// player does not autoplay on its own). The mint is the stamp trigger, and it must
// therefore fire on consumption, not on curiosity. The full rationale — including
// why the stamp must NOT be moved to a client signal (a NULL first_played_at
// leaves a rental active for 30 DAYS, window.ts:20-35) — lives in
// EpisodePlayGate.tsx. Read it before touching this branch.
export default function EpisodeModal({
  episode,
  onClose,
}: {
  episode: TitleEpisode | null;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!episode) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      document.removeEventListener("keydown", onKey);
    };
  }, [episode, onClose]);

  const stop = useCallback((e: React.MouseEvent) => e.stopPropagation(), []);

  return (
    <AnimatePresence>
      {episode && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={episode.label ?? `Episode ${episode.episode_number}`}
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
            initial={{ opacity: 0, scale: 0.98 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.98 }}
            transition={{ duration: 0.22, ease: "easeOut" }}
            onClick={stop}
            className="relative z-10 flex h-full w-full flex-col bg-moonbeem-black md:h-auto md:max-h-[90vh] md:w-auto md:max-w-[600px] md:overflow-hidden md:rounded-2xl md:border md:border-white/10 md:shadow-2xl md:shadow-black/60"
          >
            <div className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
              <span className="truncate text-body-sm font-medium text-moonbeem-ink">
                {episode.label ?? `Episode ${episode.episode_number}`}
              </span>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="flex h-11 w-11 items-center justify-center rounded-md text-body text-moonbeem-ink-subtle hover:text-moonbeem-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-moonbeem-pink"
              >
                ✕
              </button>
            </div>
            <div className="flex flex-1 items-start justify-center overflow-y-auto bg-moonbeem-navy/20 p-3">
              <div className="w-full max-w-[540px]">
                {episode.source === "mux" ? (
                  // MUX branch: still + play button. The player (and the token
                  // mint, and the rental-clock stamp) arrive only on a play click.
                  <EpisodePlayGate episode={episode} />
                ) : episode.embed_url ? (
                  // INSTAGRAM branch — unchanged: tokenless public embed.
                  <InstagramEmbed
                    url={episode.embed_url}
                    width="100%"
                    retryDelay={1000}
                    placeholderDisabled
                  />
                ) : null}
              </div>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
