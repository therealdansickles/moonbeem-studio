"use client";

// Creator SELF-PREVIEW player island (Phase 4). Mints a fresh, short-lived
// playback + DRM token for the OWNER's own hosted episode (GET
// /api/me/hosting/titles/[id]/episodes/[episodeId]/playback-token) and feeds it
// to MuxPlayer. Mirrors MuxEpisodePlayer, but the creator route is owner-only
// (no entitlement / territory), so the only error kinds are auth + unavailable.
// The CALLER controls when this mounts (fetch-on-play), so a token is minted
// only when the owner actually clicks Preview.

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import PlayerLoading from "@/components/PlayerLoading";

const MuxPlayer = dynamic(() => import("@mux/mux-player-react"), {
  ssr: false,
  loading: () => <PlayerLoading />,
});

type TokenState =
  | { status: "loading" }
  | { status: "ready"; playbackId: string; playbackToken: string; drmToken: string }
  | { status: "error"; kind: "auth" | "unavailable" };

export default function CreatorEpisodePreview({
  titleId,
  episodeId,
}: {
  titleId: string;
  episodeId: string;
}) {
  const [tokenState, setTokenState] = useState<TokenState>({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    setTokenState({ status: "loading" });
    (async () => {
      try {
        const res = await fetch(
          `/api/me/hosting/titles/${titleId}/episodes/${episodeId}/playback-token`,
          { signal: controller.signal },
        );
        if (!res.ok) {
          // Owner-only route: 401 = signed-out; everything else non-2xx is a
          // generic "unavailable" (the body may not be JSON — don't await it).
          setTokenState({
            status: "error",
            kind: res.status === 401 ? "auth" : "unavailable",
          });
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
        if (controller.signal.aborted) return;
        setTokenState({ status: "error", kind: "unavailable" });
      }
    })();
    return () => controller.abort();
  }, [titleId, episodeId]);

  if (tokenState.status === "ready") {
    return (
      <MuxPlayer
        playbackId={tokenState.playbackId}
        tokens={{ playback: tokenState.playbackToken, drm: tokenState.drmToken }}
        streamType="on-demand"
        style={{ width: "100%", maxHeight: "70vh" }}
      />
    );
  }
  if (tokenState.status === "error") {
    return (
      <div className="flex min-h-[240px] w-full items-center justify-center px-4 text-center text-body-sm text-moonbeem-ink-subtle">
        {tokenState.kind === "auth"
          ? "Sign in to preview this video."
          : "This video can't be previewed right now."}
      </div>
    );
  }
  return <PlayerLoading />;
}
