"use client";

// Stills tab on /t/[slug]. The lightbox's Download toolbar button is
// gated (Gating Phase 2): a custom download function routes through
// /api/stills/[id]/download, which runs the tier/quota check and
// proxies the bytes. A 403 opens the GateModal.
//
// The quota affordance ("N left") rides in the lightbox toolbar
// (Option 2 — custom toolbar node) since stills have no per-card
// download button — download lives only in the lightbox.
//
// SOFT GATE: still.file_url is still a public R2 URL (the photo grid
// + lightbox need it), so this gates the Download UI flow, not the
// bytes. Hard enforcement is the Phase 4 backlog.

import { useState } from "react";
import { RowsPhotoAlbum, type Photo } from "react-photo-album";
import "react-photo-album/rows.css";
import Lightbox from "yet-another-react-lightbox";
import Download from "yet-another-react-lightbox/plugins/download";
import "yet-another-react-lightbox/styles.css";
import type { Still } from "@/lib/queries/titles";
import type { Tier } from "@/lib/gating/types";
import { gateMap } from "@/lib/gating/gate-map";
import GateModal from "@/components/gating/GateModal";

type GateReason =
  | "auth_required"
  | "verification_required"
  | "limit_reached";

type Props = {
  stills: Still[];
  // Effective tier for the quota affordance — the page coerces
  // super-admins to "verified" here (server still bypasses for real).
  tier: Tier;
  stillDownloadUsage: number;
};

const FALLBACK_W = 1600;
const FALLBACK_H = 1067;

// The signed_in lifetime still-download quota, read from the gate map.
const SIGNED_IN_STILL_LIMIT = (() => {
  const cfg = gateMap.download_still.signed_in;
  return cfg.allowed && "limit" in cfg ? cfg.limit.count : null;
})();

export default function StillsTab({
  stills,
  tier,
  stillDownloadUsage,
}: Props) {
  const [index, setIndex] = useState(-1);
  const [usage, setUsage] = useState(stillDownloadUsage);
  const [gate, setGate] = useState<{
    reason: GateReason;
    limit?: number;
    used?: number;
  } | null>(null);

  if (!stills || stills.length === 0) {
    return (
      <div className="py-12 text-center">
        <p className="text-body text-moonbeem-ink-muted">
          No stills available yet.
        </p>
      </div>
    );
  }

  const withFiles = stills.filter((s) => !!s.file_url);
  const photos: Photo[] = withFiles.map((s) => ({
    src: s.file_url!,
    alt: s.alt_text ?? "",
    width: s.width ?? FALLBACK_W,
    height: s.height ?? FALLBACK_H,
  }));

  // No per-slide `download` URL — gating runs through the custom
  // download function on the Lightbox below, keyed off slide.src.
  const slides = photos.map((p) => ({
    src: p.src,
    alt: p.alt,
    width: p.width,
    height: p.height,
  }));

  // Quota label — only the signed_in tier carries a still quota.
  const quotaLabel =
    tier === "signed_in" &&
    SIGNED_IN_STILL_LIMIT != null &&
    usage > 0 &&
    SIGNED_IN_STILL_LIMIT - usage > 0
      ? `${SIGNED_IN_STILL_LIMIT - usage} left`
      : null;

  async function handleDownload({
    slide,
  }: {
    slide: { src?: string };
  }): Promise<void> {
    const src = slide.src;
    const still = withFiles.find((s) => s.file_url === src);
    if (!still) return;
    try {
      const res = await fetch(`/api/stills/${still.id}/download`);
      if (res.status === 403) {
        const json = (await res.json().catch(() => ({}))) as {
          error?: GateReason;
          limit?: number;
          used?: number;
        };
        setGate({
          reason: json.error ?? "auth_required",
          limit: json.limit,
          used: json.used,
        });
        if (typeof json.used === "number") setUsage(json.used);
        return;
      }
      if (!res.ok) return;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${still.alt_text || "still"}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setUsage((u) => u + 1);
    } catch {
      // Network failure — leave the lightbox as is; the user can retry.
    }
  }

  return (
    <>
      <RowsPhotoAlbum
        photos={photos}
        targetRowHeight={220}
        spacing={8}
        onClick={({ index }) => setIndex(index)}
      />
      <Lightbox
        open={index >= 0}
        index={index}
        close={() => setIndex(-1)}
        slides={slides}
        plugins={[Download]}
        download={{ download: handleDownload }}
        toolbar={{
          buttons: [
            quotaLabel ? (
              <span
                key="still-quota"
                className="yarl__button px-2 text-body-sm text-moonbeem-ink-muted"
              >
                {quotaLabel}
              </span>
            ) : null,
            "download",
            "close",
          ],
        }}
      />

      <GateModal
        open={!!gate}
        onClose={() => setGate(null)}
        reason={gate?.reason ?? "auth_required"}
        limit={gate?.limit}
        used={gate?.used}
        capabilityType="stills"
        returnTo={
          typeof window !== "undefined" ? window.location.pathname : "/"
        }
      />
    </>
  );
}
