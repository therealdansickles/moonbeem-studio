"use client";

import { useState } from "react";
import Image from "next/image";
import type { TitleEpisode } from "@/lib/queries/titles";
import EpisodeModal from "./EpisodeModal";

// Watch-tab content: an ordered VERTICAL list of episodes (one row each),
// not a clip grid. Clicking a row opens the standalone EpisodeModal.
// Cover thumbnail falls back to a numbered gradient tile when
// cover_image_url is null — no broken image, no Instagram call.
export default function EpisodeList({
  episodes,
}: {
  episodes: TitleEpisode[];
}) {
  const [openEpisode, setOpenEpisode] = useState<TitleEpisode | null>(null);

  return (
    <div className="flex flex-col gap-2">
      {episodes.map((ep) => {
        const label = ep.label ?? `Episode ${ep.episode_number}`;
        return (
          <button
            key={ep.id}
            type="button"
            onClick={() => setOpenEpisode(ep)}
            className="group flex items-center gap-4 rounded-xl border border-white/10 bg-white/[0.02] p-3 text-left transition-colors hover:border-moonbeem-pink/40 hover:bg-moonbeem-pink/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-moonbeem-pink"
          >
            <div className="relative h-[68px] w-[68px] shrink-0 overflow-hidden rounded-lg bg-moonbeem-navy/40">
              {ep.cover_image_url ? (
                <Image
                  src={ep.cover_image_url}
                  alt={label}
                  fill
                  sizes="68px"
                  className="object-cover"
                  unoptimized
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-moonbeem-navy to-black text-body font-semibold text-moonbeem-ink-subtle">
                  {ep.episode_number}
                </div>
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-caption text-moonbeem-ink-subtle">
                Episode {ep.episode_number}
              </div>
              <div className="truncate text-body-sm font-medium text-moonbeem-ink group-hover:text-moonbeem-pink">
                {label}
              </div>
            </div>
            <span
              aria-hidden
              className="pr-1 text-body text-moonbeem-ink-subtle group-hover:text-moonbeem-pink"
            >
              ▶
            </span>
          </button>
        );
      })}
      <EpisodeModal episode={openEpisode} onClose={() => setOpenEpisode(null)} />
    </div>
  );
}
