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
        // ⚠️ OWNER PREVIEWS ARE NOT AUDIENCE. EXCLUDE custom_3 = "preview" BY
        // DEFAULT IN EVERY DOWNSTREAM QUERY, DASHBOARD, AND METRIC.
        //
        // This player is a filmmaker scrubbing their OWN upload. Those views were
        // ALREADY landing in Mux Data — anonymously, in the same pool as real
        // viewers (this route is FREE-TIER: it gates on ownership only, no tier or
        // quota check, and free hosts 120 minutes). C4 is the change that makes that
        // pool joinable and readable, so C4 is the change that decides whether a
        // partner dashboard counts a creator previewing their own file as audience
        // engagement. Shipping the join without this marker would bake a fabricated
        // statistic into the data model — the no-fabricated-numbers rule arriving
        // through a telemetry field instead of a deck. Hence the marker ships in the
        // SAME commit as the join (Dan's ruling, 2026-07-14).
        //
        // ONE field, deliberately. NO viewer_user_id: the owner is not an audience
        // member, so there is no person to identify and therefore NO consent surface
        // here at all — which is why this component, unlike MuxEpisodePlayer, does
        // not touch useConsent(). NO video_title/custom_2 join keys either: the point
        // is EXCLUSION, not attribution. Do not expand this.
        metadata={{ custom_3: "preview" }}
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
