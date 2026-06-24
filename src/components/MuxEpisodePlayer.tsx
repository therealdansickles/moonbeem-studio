"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import type { TitleEpisode } from "@/lib/queries/titles";
import PlayerLoading from "@/components/PlayerLoading";

// Mux player is a client-only web component — load it lazily and never on the
// server. Its own chunk-load shows the same placeholder.
const MuxPlayer = dynamic(() => import("@mux/mux-player-react"), {
  ssr: false,
  loading: () => <PlayerLoading />,
});

// Shared DRM player island for ONE mux episode. Mints a fresh, short-lived
// playback + DRM license token (POST /api/episodes/[id]/playback-token) and feeds
// it to MuxPlayer. Each mount = one license (the correct DRM model).
//
// Extracted VERBATIM from EpisodeModal so the series modal AND the feature hero
// share one player path — neither changes the token flow. The CALLER controls
// WHEN this mounts (and therefore when the token fetches): the modal mounts it on
// open; the hero mounts it on the play click (fetch-on-play). FanEditModal and
// the playback-token route are untouched.
type TokenState =
  | { status: "loading" }
  | {
      status: "ready";
      playbackId: string;
      playbackToken: string;
      drmToken: string;
    }
  | { status: "error" };

export default function MuxEpisodePlayer({
  episode,
}: {
  episode: TitleEpisode;
}) {
  const [tokenState, setTokenState] = useState<TokenState>({
    status: "loading",
  });
  useEffect(() => {
    if (episode.source !== "mux" || !episode.mux_playback_id) return;
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

  if (tokenState.status === "ready") {
    return (
      <MuxPlayer
        playbackId={tokenState.playbackId}
        tokens={{
          playback: tokenState.playbackToken,
          drm: tokenState.drmToken,
        }}
        streamType="on-demand"
        style={{ width: "100%", maxHeight: "80vh" }}
      />
    );
  }
  if (tokenState.status === "error") {
    return (
      <div className="flex min-h-[320px] w-full items-center justify-center px-4 text-center text-body-sm text-moonbeem-ink-subtle">
        This episode can&apos;t be played right now.
      </div>
    );
  }
  return <PlayerLoading />;
}
