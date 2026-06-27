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
  | {
      status: "error";
      kind: "auth" | "not_entitled" | "territory" | "unavailable";
    };

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
          // Branch on the status code alone — the route returns distinguishable
          // codes (401/402/451), and the error body may not be JSON, so don't
          // await it. Anything else non-2xx is a generic "unavailable".
          let kind: "auth" | "not_entitled" | "territory" | "unavailable";
          if (res.status === 401) kind = "auth";
          else if (res.status === 402) kind = "not_entitled";
          else if (res.status === 451) kind = "territory";
          else kind = "unavailable";
          setTokenState({ status: "error", kind });
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
        // A thrown error (network failure, or a non-JSON 200 reaching .json())
        // is never an auth/payment signal — always "unavailable".
        setTokenState({ status: "error", kind: "unavailable" });
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
    let message: string;
    switch (tokenState.kind) {
      case "auth":
        message = "Sign in to watch this film.";
        break;
      case "not_entitled":
        message = "Rent or buy this film to watch.";
        break;
      case "territory":
        message = "This film isn't available in your region.";
        break;
      case "unavailable":
        message = "This episode can't be played right now.";
        break;
    }
    return (
      <div className="flex min-h-[320px] w-full items-center justify-center px-4 text-center text-body-sm text-moonbeem-ink-subtle">
        {message}
      </div>
    );
  }
  return <PlayerLoading />;
}
