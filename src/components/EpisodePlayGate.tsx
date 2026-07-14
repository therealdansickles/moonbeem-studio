"use client";

import { useState, type ReactNode } from "react";
import Image from "next/image";
import type { TitleEpisode } from "@/lib/queries/titles";
import MuxEpisodePlayer from "@/components/MuxEpisodePlayer";

// ⚠️ MONEY-ADJACENT. THE ONLY play gate. Both callers (HeroPlayer for features,
// EpisodeModal for series episodes) go through this file — deliberately, because
// two copies of this gate means two places to get a rental clock wrong. Sizing and
// poster differences ride on props; the RULE lives here, once.
//
// THE RULE: a minted token is a CAPABILITY; a played frame is CONSUMPTION. Only
// consumption starts the 48-hour rental clock. So the playback-token POST — which
// is what stamps entitlements.first_played_at — must not fire until the viewer
// actually commits to watching.
//
// Mounting <MuxEpisodePlayer> IS the mint (it POSTs on mount,
// MuxEpisodePlayer.tsx). So this gate holds a still image until an explicit play
// click, and only THEN mounts the player. Opening an episode mints nothing.
//
// THE BUG THIS FIXES (latent, not live — see below): EpisodeModal mounted the
// player the instant the modal opened, so clicking an episode row merely to look
// at it started the viewer's 48-hour clock — and because the player did not
// autoplay, they were then shown a PAUSED player. A viewer could open an episode,
// play zero frames, close it, and return the next day to a burned rental.
// HeroPlayer was only *better*, not correct: it gated on a play click, but the
// viewer still landed on a paused player, so even there the clock started a click
// before any frame decoded. MuxEpisodePlayer now passes autoPlay, so the mount —
// which IS the user's play gesture — actually plays.
//
// LATENT, NOT LIVE (prod, 2026-07-14): no title in production reaches the modal's
// mux branch. Every playable title is a single-episode movie (HeroPlayer); the one
// multi-episode title is 39 Instagram episodes, which take the modal's embed
// branch. The bug would have fired on the FIRST multi-episode hosted series —
// which is exactly where the creator-hosting lane is heading. That is why the fix
// ships now, ahead of the content that would have triggered it.
//
// WHY THE STAMP STAYS ON THE MINT (do not "clean this up"): the mint is the only
// UNSKIPPABLE, server-observed event in the flow. If the stamp moved to a client
// signal (a POST on the player's `playing` event), a viewer who blocks that one
// request keeps first_played_at NULL — and per window.ts:20-35 a NULL
// first_played_at does NOT mean unwatchable: it means the rental is ACTIVE FOR 30
// DAYS FROM PURCHASE, not 48 hours. That silently upgrades every 48h rental into a
// 30d rental for anyone with an ad-blocker. The fix is to move the MINT to the
// moment of consumption — this file — NOT to move the stamp off the server.
//
// ACCEPTED RESIDUAL GAP: the mint still precedes the first decoded frame by
// seconds, and a DRM license failure right after the mint burns the clock on a play
// that never happened. Rare, and strictly better than the 30-day hole above.
// Closing it requires a client-fired stamp, which reopens that hole. Ruled an
// accepted trade (Dan, 2026-07-14).
export default function EpisodePlayGate({
  episode,
  posterUrl = null,
  label,
  sizes = "(max-width: 768px) 100vw, 540px",
  roundedClassName = "rounded-xl",
  playerWrapperClassName,
  fallback,
}: {
  episode: TitleEpisode;
  posterUrl?: string | null;
  /** aria + alt text. Defaults to the episode's own label. */
  label?: string;
  /** next/image `sizes` — the two callers render at different widths. */
  sizes?: string;
  /** Corner radius of the still (hero: 2xl, modal: xl). */
  roundedClassName?: string;
  /** Optional box the player is mounted into (the hero locks a 16:9 frame so the
   *  still -> player swap does not resize; the modal renders it bare). */
  playerWrapperClassName?: string;
  /** Shown when there is no still image. Callers style their own. */
  fallback?: ReactNode;
}) {
  const [playing, setPlaying] = useState(false);
  const name = label ?? episode.label ?? `Episode ${episode.episode_number}`;

  // Committed: mount the player. It mints, stamps, and (autoPlay) starts playing —
  // no second click.
  if (playing) {
    const player = <MuxEpisodePlayer episode={episode} />;
    return playerWrapperClassName ? (
      <div className={playerWrapperClassName}>{player}</div>
    ) : (
      player
    );
  }

  const still = posterUrl ?? episode.cover_image_url ?? null;

  return (
    <button
      type="button"
      onClick={() => setPlaying(true)}
      aria-label={`Play ${name}`}
      className={`group relative block aspect-video w-full overflow-hidden border border-white/10 bg-moonbeem-navy/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-moonbeem-pink ${roundedClassName}`}
    >
      {still ? (
        <Image
          src={still}
          alt={`${name} still`}
          fill
          sizes={sizes}
          className="object-cover"
          unoptimized
        />
      ) : (
        (fallback ?? (
          <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-moonbeem-navy to-black">
            <p className="m-0 px-6 text-center text-body-sm text-moonbeem-ink-subtle">
              {name}
            </p>
          </div>
        ))
      )}
      {/* Dim + centered play affordance. */}
      <div className="absolute inset-0 bg-black/30 transition-colors group-hover:bg-black/20" />
      <span className="absolute inset-0 flex items-center justify-center">
        <span className="flex h-16 w-16 items-center justify-center rounded-full bg-moonbeem-pink/90 text-moonbeem-navy shadow-xl transition-transform group-hover:scale-105">
          <svg
            width="26"
            height="26"
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-hidden
            className="ml-1"
          >
            <path d="M8 5v14l11-7z" />
          </svg>
        </span>
      </span>
    </button>
  );
}
