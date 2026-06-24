"use client";

import { useCallback, useEffect } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { InstagramEmbed } from "react-social-media-embed";
import type { TitleEpisode } from "@/lib/queries/titles";
import MuxEpisodePlayer from "@/components/MuxEpisodePlayer";

// Standalone episode player. Two render paths, branched on episode.source:
//   - instagram: tokenless public IG embed (unchanged from before).
//   - mux: DRM playback via the shared <MuxEpisodePlayer> island (fetch-on-open
//     token -> MuxPlayer). The mux player + token flow were EXTRACTED into
//     MuxEpisodePlayer so the feature hero reuses the exact same path; the modal
//     chrome (scroll-lock, Escape, overlay, close) is unchanged. FanEditModal is
//     left entirely untouched.
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
                  // MUX branch: the shared DRM player island (token fetch-on-mount).
                  <MuxEpisodePlayer episode={episode} />
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
