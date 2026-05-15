"use client";

// Stills tab on /t/[slug]. The lightbox's Download toolbar button is
// gated (Gating Phase 2): a custom download function routes through
// /api/stills/[id]/download, which runs the tier/quota check and
// proxies the bytes.
//
// On a 403 the feedback is INLINE in the lightbox toolbar — not the
// GateModal. The GateModal renders at z-50 and the lightbox sits on
// top of it, so a modal triggered from inside the lightbox is
// invisible until the lightbox closes. Instead, the toolbar's
// Download button is replaced with a navigation CTA keyed to the
// gate reason. (Stills download has no entry point outside the
// lightbox, so the GateModal isn't used here at all.)
//
// Gate-state lifetime: limit_reached / verification_required persist
// across lightbox open/close (the quota fact doesn't change);
// auth_required resets on close (the user may be mid-sign-in).
//
// SOFT GATE: still.file_url is still a public R2 URL (the photo grid
// + lightbox need it), so this gates the Download UI flow, not the
// bytes. Hard enforcement is the Phase 4 backlog.

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { RowsPhotoAlbum, type Photo } from "react-photo-album";
import "react-photo-album/rows.css";
import Lightbox from "yet-another-react-lightbox";
import Download from "yet-another-react-lightbox/plugins/download";
import "yet-another-react-lightbox/styles.css";
import type { Still } from "@/lib/queries/titles";
import type { Tier } from "@/lib/gating/types";
import { gateMap } from "@/lib/gating/gate-map";

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
  const pathname = usePathname();
  const [index, setIndex] = useState(-1);
  const [usage, setUsage] = useState(stillDownloadUsage);
  const [gateReason, setGateReason] = useState<GateReason | null>(null);

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

  // Inline CTA shown in place of the Download button once a 403 has
  // come back — label + navigation target keyed to the gate reason.
  const encodedPath = encodeURIComponent(pathname || "/");
  const gateCta =
    gateReason === "auth_required"
      ? {
          label: "Sign in to download",
          href: `/login?redirect_to=${encodedPath}`,
        }
      : gateReason === "limit_reached"
        ? {
            label: "Verify to download",
            href: `/me/edit?return_to=${encodedPath}`,
          }
        : gateReason === "verification_required"
          ? {
              label: "Verify a handle",
              href: `/me/edit?return_to=${encodedPath}`,
            }
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
          used?: number;
        };
        // Inline toolbar feedback — NOT a modal (the lightbox would
        // hide it). The toolbar swaps Download for the CTA below.
        setGateReason(json.error ?? "auth_required");
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

  function handleClose() {
    setIndex(-1);
    // auth_required is ephemeral — the user may be about to sign in,
    // and a fresh page load resets everything anyway. limit_reached /
    // verification_required persist: that state doesn't change by
    // closing the lightbox.
    if (gateReason === "auth_required") setGateReason(null);
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
        close={handleClose}
        slides={slides}
        plugins={[Download]}
        download={{ download: handleDownload }}
        toolbar={{
          buttons: [
            // Once gated, the CTA replaces both the quota label and
            // the Download button. Clicking it navigates away, which
            // unmounts the lightbox naturally.
            gateCta ? (
              <Link
                key="still-gate-cta"
                href={gateCta.href}
                className="yarl__button px-2 text-body-sm text-moonbeem-pink hover:opacity-80"
              >
                {gateCta.label}
              </Link>
            ) : quotaLabel ? (
              <span
                key="still-quota"
                className="yarl__button px-2 text-body-sm text-moonbeem-ink-muted"
              >
                {quotaLabel}
              </span>
            ) : null,
            gateCta ? null : "download",
            "close",
          ],
        }}
      />
    </>
  );
}
