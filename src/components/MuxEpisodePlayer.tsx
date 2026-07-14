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
// ── REFRESH PATH — NETWORK-ERROR RECOVERY ONLY (C1, corrected 2026-07-14) ────
//
// ⚠️ WHAT THIS IS NOT: it does NOT stop a lapsed rental, and it never did. The
// first version of this comment claimed a mid-watch token expiry would error the
// player, fire onError, re-mint, re-check rights, and cut off an expired rental.
// That rested on an UNPROBED assumption about Mux's edge. The probe (2026-07-14,
// real published DRM asset) killed it:
//
//   EXPIRED playback token -> master .m3u8 403, variant .m3u8 403
//   ...but segment URLs carry NO token and serve HTTP 200 anyway — including
//   segments never fetched before (so it is not a caching artifact).
//
// An on-demand player fetches the manifest ONCE and then holds every segment URL.
// Nothing errors mid-playback; the session runs to the end of the film. A
// 6-minute watch on a 2-minute TTL produced ZERO refreshes — not a bug, but the
// system behaving correctly on a false premise. onError has nothing to catch
// mid-session, because nothing is denied mid-session.
//
// WHAT IT IS FOR:
//   1. Genuine network / segment failures — one cheap retry.
//   2. A MANIFEST fetch that 403s — the one thing the playback token DOES gate.
//      A session STARTING on a stale token hits this, and the re-mint recovers it
//      properly, re-running the full server gate stack (entitlement, territory,
//      window). That is a real rights path, just a narrower one than claimed.
//   3. The HOOK for C1b: license-duration claims (playDuration /
//      licenseExpiration on the drm token) CAN terminate a session — and when
//      they do, they surface as a PLAYER ERROR. This handler is where that gets
//      caught. Keep it for that.
//
// ONE retry, deliberately: a genuinely-expired entitlement must surface as
// not_entitled, not spin. We do NOT parse Mux's error taxonomy to guess WHY
// playback failed — a 403'd manifest and a flaky segment want the same cheap
// remedy, and the server is the authority on whether the viewer may continue.
//
// (Mount timing, for the record: HeroPlayer mounts on the play click, EpisodeModal
// on modal open. That governs WHEN a token is minted — it does NOT decide whether
// an in-flight session survives expiry. Per the probe, it always does.)
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
        // ⚠️ MONEY-ADJACENT (2026-07-14). autoPlay is not a convenience — it is
        // what makes "the mint is the stamp" honest. This component's ONLY mount
        // site is EpisodePlayGate, which mounts it only on an explicit play click,
        // and mounting POSTs the token, which stamps first_played_at and starts the
        // 48-hour rental clock. Without autoPlay the viewer would be shown a PAUSED
        // player after clicking play — clock already running, no frame decoded, and
        // a second click required. The mount IS the user's play gesture, so the
        // player must honour it. Do not remove this without moving the stamp, and
        // read EpisodePlayGate.tsx before considering that (spoiler: don't).
        //
        // If a browser blocks autoplay anyway (Safari is stricter), the player
        // falls back to paused-with-controls — the viewer presses play and watches.
        // The clock is already stamped in that case: the accepted residual gap.
        autoPlay
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
