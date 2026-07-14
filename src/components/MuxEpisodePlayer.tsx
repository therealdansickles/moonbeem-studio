"use client";

import { useEffect, useRef, useState } from "react";
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
//
// ── C1 REFRESH PATH (2026-07-13) ────────────────────────────────────────────
// Tokens are 4h (was 12h). The TTL cut is only safe BECAUSE of the retry below,
// and the reason is a mount-timing asymmetry between the two callers:
//
//   HeroPlayer  — mounts on the PLAY CLICK. A viewer who idles for hours and then
//                 presses play mints a FRESH token at that moment. Never strands.
//   EpisodeModal — mounts on MODAL OPEN. The token is minted when the modal opens,
//                 NOT when play is pressed. A viewer who opens the modal, walks
//                 away, and presses play 5h later is holding a 5h-old token: fine
//                 at 12h, EXPIRED at 4h.
//
// So on the modal path a 4h TTL without a refresh would hand the viewer a dead
// player. onError below re-POSTs the token route ONCE, swaps in the new tokens,
// and resumes at the same timestamp. That re-POST re-runs the FULL server gate
// stack (entitlement, territory, rental window) — which is why the refresh is a
// rights GAIN, not just a UX patch: a rental that lapses mid-watch now stops at
// the next refresh instead of coasting on a long-lived token.
//
// ONE retry, deliberately. A genuinely-expired entitlement must surface as
// not_entitled, not spin; and misclassifying a transient network blip as expiry
// costs at most one wasted POST (rate-limited, harmless) — which is why we don't
// try to parse Mux's error taxonomy to guess WHY playback failed.
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
  // Bumped once by onError to re-run the mint effect. 0 = first mint, 1 = the
  // single allowed refresh. Never goes higher.
  const [attempt, setAttempt] = useState(0);
  // Where playback was when the token died, so the re-minted player resumes there
  // instead of restarting the film.
  const resumeAtRef = useRef(0);

  useEffect(() => {
    if (episode.source !== "mux" || !episode.mux_playback_id) return;
    const controller = new AbortController();
    // On a REFRESH (attempt > 0) keep the current player mounted with its stale
    // tokens until the new ones land — flipping to "loading" would tear the
    // player down mid-watch and flash the placeholder for a swap the viewer
    // should barely notice.
    if (attempt === 0) setTokenState({ status: "loading" });
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
          // This is ALSO the refresh outcome that matters: a rental that lapsed
          // mid-watch re-mints into a 402 here and the player stops.
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
  }, [episode, attempt]);

  // Any fatal player error gets ONE re-mint. We do NOT inspect the error code:
  // an expired token and a flaky segment fetch both want the same cheap remedy,
  // and the server is the authority on whether the viewer may keep watching.
  function handlePlayerError(evt: { target?: unknown }) {
    if (attempt > 0) return; // already spent the one retry
    const el = evt?.target as { currentTime?: number } | undefined;
    resumeAtRef.current =
      typeof el?.currentTime === "number" ? el.currentTime : 0;
    setAttempt(1);
  }

  if (tokenState.status === "ready") {
    return (
      <MuxPlayer
        playbackId={tokenState.playbackId}
        tokens={{
          playback: tokenState.playbackToken,
          drm: tokenState.drmToken,
        }}
        streamType="on-demand"
        // Swapping `tokens` reloads the source; startTime puts the viewer back
        // where the old token died (0 on a first mint).
        startTime={resumeAtRef.current}
        onError={handlePlayerError}
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
