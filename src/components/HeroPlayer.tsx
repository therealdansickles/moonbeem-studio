"use client";

import type { TitleEpisode } from "@/lib/queries/titles";
import EpisodePlayGate from "@/components/EpisodePlayGate";

// Inline single-asset hero for a FEATURE film on the Watch tab (a title with
// media_type='movie' + exactly one episode). Shows a 16:9 pre-play still
// (poster_url -> episode cover_image_url -> a title-text gradient, mirroring the
// left-rail poster fallback) with a prominent play button.
//
// CRITICAL — fetch-on-PLAY: the DRM player (and therefore the playback-token POST)
// mounts ONLY when the play button is clicked. Before the click NO token fires —
// an eagerly-mounted player would spend a token + churn a DRM license on every
// feature page load. No modal / no scroll-lock — an in-page hero, width-bounded by
// the right-column Watch tabpanel.
//
// ⚠️ MONEY-ADJACENT, and this file is now a THIN CALLER on purpose. The play gate
// itself lives in ONE place — EpisodePlayGate — because the mount is what mints the
// playback token, and the mint is what STAMPS entitlements.first_played_at and
// starts the 48-hour rental clock (playback-token/route.ts). A second copy of that
// gate is a second place to get a rental clock wrong; this component used to be
// exactly that copy. Sizing and poster differences ride on props. Read
// EpisodePlayGate.tsx before changing anything here — the rule, the 30-day hole
// that makes a client-side stamp unsafe, and the accepted residual gap are all
// documented there.
export default function HeroPlayer({
  episode,
  posterUrl,
  title,
}: {
  episode: TitleEpisode;
  posterUrl: string | null;
  title: string;
}) {
  return (
    <EpisodePlayGate
      episode={episode}
      posterUrl={posterUrl}
      label={title}
      sizes="(max-width: 768px) 100vw, 720px"
      roundedClassName="rounded-2xl"
      // Lock the player to the SAME fixed 16:9 box the still occupied: the outer
      // frame stays aspect-video (no size change on swap), and the mux-player fills
      // it (h-full + max-h-none override its inline max-height) instead of imposing
      // its own default aspect on mount — so still -> player has NO resize jump; the
      // video letterboxes inside the stable frame.
      playerWrapperClassName="aspect-video w-full overflow-hidden rounded-2xl border border-white/10 bg-black [&_mux-player]:h-full [&_mux-player]:!max-h-none"
      fallback={
        <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-moonbeem-navy to-black">
          <p className="m-0 px-6 text-center font-wordmark text-display-sm text-moonbeem-pink/80">
            {title}
          </p>
        </div>
      }
    />
  );
}
