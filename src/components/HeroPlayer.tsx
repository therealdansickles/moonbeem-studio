"use client";

import Image from "next/image";
import { useState } from "react";
import type { TitleEpisode } from "@/lib/queries/titles";
import MuxEpisodePlayer from "@/components/MuxEpisodePlayer";

// Inline single-asset hero for a FEATURE film on the Watch tab (a title with
// media_type='movie' + exactly one episode). Shows a 16:9 pre-play still
// (poster_url -> episode cover_image_url -> a title-text gradient, mirroring the
// left-rail poster fallback) with a prominent play button.
//
// CRITICAL — fetch-on-PLAY: the DRM player (and therefore the playback-token POST)
// mounts ONLY when the play button is clicked. Before the click NO token fires —
// an eagerly-mounted player would spend a token + churn a DRM license on every
// feature page load. On play we mount <MuxEpisodePlayer> (the same island the
// series modal uses) in place of the still. No modal / no scroll-lock — an in-page
// hero, width-bounded by the right-column Watch tabpanel.
export default function HeroPlayer({
  episode,
  posterUrl,
  title,
}: {
  episode: TitleEpisode;
  posterUrl: string | null;
  title: string;
}) {
  const [playing, setPlaying] = useState(false);

  if (playing) {
    // Lock the player to the SAME fixed 16:9 box the still occupied: the outer
    // frame stays aspect-video (no size change on swap), and the mux-player fills
    // it (h-full + max-h-none override its inline max-height) instead of imposing
    // its own default aspect on mount — so still -> player has NO resize jump; the
    // video letterboxes inside the stable frame. Scoped to HeroPlayer: the shared
    // MuxEpisodePlayer island and the modal's sizing are untouched.
    return (
      <div className="aspect-video w-full overflow-hidden rounded-2xl border border-white/10 bg-black [&_mux-player]:h-full [&_mux-player]:!max-h-none">
        <MuxEpisodePlayer episode={episode} />
      </div>
    );
  }

  const still = posterUrl ?? episode.cover_image_url ?? null;

  return (
    <button
      type="button"
      onClick={() => setPlaying(true)}
      aria-label={`Play ${title}`}
      className="group relative block aspect-video w-full overflow-hidden rounded-2xl border border-white/10 bg-moonbeem-navy/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-moonbeem-pink"
    >
      {still ? (
        <Image
          src={still}
          alt={`${title} still`}
          fill
          sizes="(max-width: 768px) 100vw, 720px"
          className="object-cover"
          unoptimized
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-moonbeem-navy to-black">
          <p className="font-wordmark text-display-sm text-moonbeem-pink/80 px-6 text-center m-0">
            {title}
          </p>
        </div>
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
