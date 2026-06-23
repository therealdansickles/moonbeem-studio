"use client";

import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import dynamic from "next/dynamic";
import { InstagramEmbed } from "react-social-media-embed";
import type { TitleEpisode } from "@/lib/queries/titles";
import PlayerLoading from "@/components/PlayerLoading";

// Mux player is a client-only web component — load it lazily and never on the
// server. Its own chunk-load shows the same placeholder.
const MuxPlayer = dynamic(() => import("@mux/mux-player-react"), {
  ssr: false,
  loading: () => <PlayerLoading />,
});

// Standalone episode player. Two render paths, branched on episode.source:
//   - instagram: tokenless public IG embed (unchanged from before).
//   - mux: DRM playback. On open we mint a fresh, short-lived playback + DRM
//     license token (POST /api/episodes/[id]/playback-token) and feed it to
//     MuxPlayer. Fetch-on-open is the correct DRM model — each view gets its own
//     license. FanEditModal is left entirely untouched.
type TokenState =
  | { status: "loading" }
  | { status: "ready"; playbackId: string; playbackToken: string; drmToken: string }
  | { status: "error" };

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

  // Mux token: fetch-on-open. Re-runs when the open episode changes (or the
  // modal closes -> episode null). The AbortController + aborted-guard ensure a
  // late response from a previously-open episode never applies to the current one.
  const [tokenState, setTokenState] = useState<TokenState>({ status: "loading" });
  useEffect(() => {
    if (!episode || episode.source !== "mux" || !episode.mux_playback_id) return;
    const controller = new AbortController();
    setTokenState({ status: "loading" });
    (async () => {
      try {
        const res = await fetch(`/api/episodes/${episode.id}/playback-token`, {
          method: "POST",
          signal: controller.signal,
        });
        if (!res.ok) {
          setTokenState({ status: "error" });
          return;
        }
        const data = (await res.json()) as {
          playbackId: string;
          playbackToken: string;
          drmToken: string;
        };
        setTokenState({
          status: "ready",
          playbackId: data.playbackId,
          playbackToken: data.playbackToken,
          drmToken: data.drmToken,
        });
      } catch {
        if (controller.signal.aborted) return; // closed/changed — ignore
        setTokenState({ status: "error" });
      }
    })();
    return () => controller.abort();
  }, [episode]);

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
                  // MUX branch: fetch-on-open token -> DRM player.
                  tokenState.status === "ready" ? (
                    <MuxPlayer
                      playbackId={tokenState.playbackId}
                      tokens={{
                        playback: tokenState.playbackToken,
                        drm: tokenState.drmToken,
                      }}
                      streamType="on-demand"
                      style={{ width: "100%", maxHeight: "80vh" }}
                    />
                  ) : tokenState.status === "error" ? (
                    <div className="flex min-h-[320px] w-full items-center justify-center px-4 text-center text-body-sm text-moonbeem-ink-subtle">
                      This episode can&apos;t be played right now.
                    </div>
                  ) : (
                    <PlayerLoading />
                  )
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
