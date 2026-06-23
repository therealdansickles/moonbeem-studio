"use client";

// TEMP debug client — DELETE BEFORE MERGE (step 4 player verification only).
// Mounts the real EpisodeModal for one episode so we can confirm mux DRM
// playback on the preview without publishing anything.
import { useState } from "react";
import EpisodeModal from "@/components/EpisodeModal";
import type { TitleEpisode } from "@/lib/queries/titles";

export default function MuxPlayDebugClient({
  episode,
}: {
  episode: TitleEpisode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div className="min-h-screen bg-moonbeem-black">
      <EpisodeModal
        episode={open ? episode : null}
        onClose={() => setOpen(false)}
      />
      {!open && (
        <div className="flex min-h-screen items-center justify-center">
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="rounded-md border border-white/10 px-4 py-2 text-moonbeem-ink"
          >
            Reopen episode
          </button>
        </div>
      )}
    </div>
  );
}
