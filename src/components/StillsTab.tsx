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
import { zipSync } from "fflate";
import type { Still } from "@/lib/queries/titles";
import type { Tier } from "@/lib/gating/types";
import { gateMap } from "@/lib/gating/gate-map";
import GateModal from "@/components/gating/GateModal";
import { dedupeName, shouldZipStillsInMemory } from "@/lib/downloads/bundle";
import {
  triggerAnchorDownload,
  triggerBlobDownload,
} from "@/lib/downloads/trigger";

type GateReason =
  | "auth_required"
  | "verification_required"
  | "limit_reached";

type Props = {
  stills: Still[];
  titleId: string;
  titleSlug: string;
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
  titleId,
  titleSlug,
  tier,
  stillDownloadUsage,
}: Props) {
  const pathname = usePathname();
  const [index, setIndex] = useState(-1);
  const [usage, setUsage] = useState(stillDownloadUsage);
  const [gateReason, setGateReason] = useState<GateReason | null>(null);
  // "Download all stills" — header action (outside the lightbox, so it CAN use
  // the GateModal). Client-side fflate zip for normal sets; a size guard falls
  // back to sequential downloads above ~500 MB so a large set can't OOM the tab.
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkLabel, setBulkLabel] = useState("");
  const [bulkError, setBulkError] = useState(false);
  const [showMultiNote, setShowMultiNote] = useState(false);
  const [bulkGate, setBulkGate] = useState<{ reason: GateReason } | null>(null);

  async function handleDownloadAllStills() {
    if (bulkBusy) return;
    setBulkBusy(true);
    setBulkError(false);
    setShowMultiNote(false);
    setBulkLabel("Preparing…");
    try {
      const res = await fetch(`/api/titles/${titleId}/download-all`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "stills" }),
      });
      if (res.status === 403) {
        const json = (await res.json().catch(() => ({}))) as {
          error?: GateReason;
        };
        setBulkGate({ reason: json.error ?? "auth_required" });
        return;
      }
      if (!res.ok) {
        setBulkError(true);
        return;
      }
      const { items } = (await res.json()) as {
        items: { url: string; filename: string; size: number | null }[];
      };
      if (!items || items.length === 0) {
        setBulkError(true);
        return;
      }

      const totalBytes = items.reduce((sum, it) => sum + (it.size ?? 0), 0);
      if (!shouldZipStillsInMemory(totalBytes)) {
        // Large set — sequential fallback (same mechanism as clips), no
        // in-memory zip. Covers the ~595 MB / 103-image outlier.
        setShowMultiNote(items.length > 1);
        for (let i = 0; i < items.length; i++) {
          setBulkLabel(`Downloading ${i + 1} of ${items.length}…`);
          triggerAnchorDownload(items[i].url, items[i].filename);
          if (i < items.length - 1) {
            await new Promise((r) => setTimeout(r, 800));
          }
        }
        return;
      }

      // In-memory zip via fflate. Fetch each object (CORS-permitted on prod),
      // dedupe entry names, then store (level 0 — jpeg/png/webp are already
      // compressed, so deflate burns CPU for ~0 gain).
      const files: Record<string, Uint8Array> = {};
      const used = new Set<string>();
      for (let i = 0; i < items.length; i++) {
        setBulkLabel(`Fetching ${i + 1} of ${items.length}…`);
        const r = await fetch(items[i].url);
        if (!r.ok) throw new Error("fetch_failed");
        files[dedupeName(items[i].filename, used)] = new Uint8Array(
          await r.arrayBuffer(),
        );
      }
      setBulkLabel("Zipping…");
      const zipped = zipSync(files, { level: 0 });
      triggerBlobDownload(
        new Blob([zipped], { type: "application/zip" }),
        `${titleSlug}-stills.zip`,
      );
    } catch {
      setBulkError(true);
    } finally {
      setBulkBusy(false);
      setBulkLabel("");
    }
  }

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
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="m-0 text-body-sm text-moonbeem-ink-muted">
          {withFiles.length} still{withFiles.length === 1 ? "" : "s"}
        </p>
        <button
          type="button"
          onClick={handleDownloadAllStills}
          disabled={bulkBusy}
          className="shrink-0 rounded-md border border-white/10 px-3 py-1.5 text-body-sm text-moonbeem-pink transition-colors hover:border-moonbeem-pink disabled:cursor-not-allowed disabled:opacity-50"
        >
          {bulkBusy ? bulkLabel || "Preparing…" : "Download all stills"}
        </button>
      </div>
      {showMultiNote && (
        <p className="mb-4 -mt-2 text-caption text-moonbeem-ink-subtle">
          Your browser may ask permission to download multiple files —
          that&rsquo;s expected; allow it to get every still.
        </p>
      )}
      {bulkError && (
        <p className="mb-4 -mt-2 text-caption text-moonbeem-magenta">
          Couldn&rsquo;t start the download. Try again.
        </p>
      )}
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
      <GateModal
        open={!!bulkGate}
        onClose={() => setBulkGate(null)}
        reason={bulkGate?.reason ?? "auth_required"}
        capabilityType="stills"
        returnTo={pathname || "/"}
      />
    </>
  );
}
