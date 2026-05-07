"use client";

import { useMemo, useState } from "react";
import type { FanEdit } from "@/lib/queries/titles";
import FanEditThumbnail from "./FanEditThumbnail";
import FanEditModal from "./FanEditModal";

type Props = {
  // Already sorted view_count DESC (then created_at DESC) by the
  // query in titles.ts — preserved here for the modal arrow-nav,
  // which crosses platform sections.
  fanEdits: FanEdit[];
  titleSlug: string;
  titleName: string;
};

const platformOrder = ["tiktok", "instagram", "twitter", "youtube"] as const;

const platformLabel: Record<(typeof platformOrder)[number], string> = {
  tiktok: "TikTok",
  instagram: "Instagram",
  twitter: "X",
  youtube: "YouTube",
};

const EAGER_LOAD_COUNT = 6;

export default function FanEditsTab({
  fanEdits,
  titleSlug,
  titleName,
}: Props) {
  const [openIndex, setOpenIndex] = useState(-1);

  // Group by platform while preserving each platform's relative
  // view-count-DESC order (the input is already sorted).
  const grouped = useMemo(() => {
    const g: Record<(typeof platformOrder)[number], FanEdit[]> = {
      tiktok: [],
      instagram: [],
      twitter: [],
      youtube: [],
    };
    for (const fe of fanEdits) g[fe.platform].push(fe);
    return g;
  }, [fanEdits]);

  // Modal arrow-nav uses the full sorted list, indexed by id.
  const indexById = useMemo(() => {
    const m = new Map<string, number>();
    fanEdits.forEach((fe, i) => m.set(fe.id, i));
    return m;
  }, [fanEdits]);

  // First-N thumbnails across DOM order (platform sections in
  // platformOrder) get loading="eager" so the above-the-fold tiles
  // start fetching immediately.
  const eagerIds = useMemo(() => {
    const ids = new Set<string>();
    let count = 0;
    for (const platform of platformOrder) {
      for (const fe of grouped[platform]) {
        if (count < EAGER_LOAD_COUNT) ids.add(fe.id);
        count++;
      }
    }
    return ids;
  }, [grouped]);

  if (fanEdits.length === 0) {
    return (
      <div className="py-12 text-center text-body text-moonbeem-ink-muted">
        No fan edits yet. Check back soon.
      </div>
    );
  }

  return (
    <>
      <div className="flex flex-col gap-12">
        <p className="text-body-sm text-moonbeem-ink-muted">
          Authorized fan edits across TikTok, Instagram, and X.
        </p>

        {platformOrder.map((platform) => {
          const edits = grouped[platform];
          if (edits.length === 0) return null;
          return (
            <section key={platform}>
              <h3 className="text-body font-medium text-moonbeem-ink-muted">
                {platformLabel[platform]}
              </h3>
              <div className="mt-2 mb-6 border-t border-white/10" />
              <div className="grid grid-cols-2 items-start gap-3 sm:grid-cols-3 md:gap-4 lg:grid-cols-4">
                {edits.map((fe) => (
                  <FanEditThumbnail
                    key={fe.id}
                    fanEdit={fe}
                    eager={eagerIds.has(fe.id)}
                    onOpen={() => setOpenIndex(indexById.get(fe.id) ?? -1)}
                  />
                ))}
              </div>
            </section>
          );
        })}
      </div>

      <FanEditModal
        fanEdits={fanEdits}
        openIndex={openIndex}
        titleSlug={titleSlug}
        titleName={titleName}
        onClose={() => setOpenIndex(-1)}
        onNavigate={setOpenIndex}
      />
    </>
  );
}
