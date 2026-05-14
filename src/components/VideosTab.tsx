"use client";

// Clips tab on /t/[slug]. The Download action is gated (Gating
// Phase 1): the button routes through /api/clips/[id]/download,
// which runs the tier/quota check and proxies the bytes. A 403
// comes back with a reason that opens the GateModal.
//
// SOFT GATE: clip.file_url is still a public R2 URL (the <video>
// player needs it), so this gates the Download UI flow, not the
// bytes. Hard enforcement is the Phase 4 backlog.

import { useState } from "react";
import type { Clip } from "@/lib/queries/titles";
import type { Tier } from "@/lib/gating/types";
import { gateMap } from "@/lib/gating/gate-map";
import GateModal from "@/components/gating/GateModal";

type GateReason =
  | "auth_required"
  | "verification_required"
  | "limit_reached";

type Props = {
  clips: Clip[];
  // Effective tier for the quota affordance — the page coerces
  // super-admins to "verified" here (server still bypasses for real).
  tier: Tier;
  clipDownloadUsage: number;
};

// The signed_in lifetime clip-download quota, read from the gate map
// so this stays in sync with the single source of truth.
const SIGNED_IN_CLIP_LIMIT = (() => {
  const cfg = gateMap.download_clip.signed_in;
  return cfg.allowed && "limit" in cfg ? cfg.limit.count : null;
})();

function formatDuration(seconds: number | null): string | null {
  if (!seconds || seconds <= 0) return null;
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function fileNameFromUrl(url: string): string {
  try {
    const path = new URL(url).pathname;
    const last = path.split("/").pop() || "clip";
    return decodeURIComponent(last);
  } catch {
    return "clip";
  }
}

export default function VideosTab({ clips, tier, clipDownloadUsage }: Props) {
  const [usage, setUsage] = useState(clipDownloadUsage);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errorId, setErrorId] = useState<string | null>(null);
  const [gate, setGate] = useState<{
    reason: GateReason;
    limit?: number;
    used?: number;
  } | null>(null);

  // Quota label — only the signed_in tier carries a clip quota.
  // 0 used or quota reached -> plain "Download" (a reached-quota
  // click falls through to the 403 -> GateModal).
  function downloadLabel(): string {
    if (tier !== "signed_in" || SIGNED_IN_CLIP_LIMIT == null) {
      return "Download";
    }
    const left = SIGNED_IN_CLIP_LIMIT - usage;
    if (usage <= 0 || left <= 0) return "Download";
    return `Download (${left} left)`;
  }

  async function handleDownload(clip: Clip) {
    if (busyId) return;
    setBusyId(clip.id);
    setErrorId(null);
    try {
      const res = await fetch(`/api/clips/${clip.id}/download`);
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
      if (!res.ok) {
        setErrorId(clip.id);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${clip.label || "clip"}.mp4`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      // Bump the local quota so the label updates without a reload.
      setUsage((u) => u + 1);
    } catch {
      setErrorId(clip.id);
    } finally {
      setBusyId(null);
    }
  }

  if (!clips || clips.length === 0) {
    return (
      <div className="py-12 text-center">
        <p className="text-body text-moonbeem-ink-muted">
          No clips available yet.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {clips.map((clip) => {
          if (!clip.file_url) return null;
          const duration = formatDuration(clip.duration_seconds);
          const displayLabel =
            clip.label?.trim() || fileNameFromUrl(clip.file_url);

          return (
            <div key={clip.id} className="flex flex-col gap-2">
              <div className="aspect-video bg-black rounded-md overflow-hidden">
                <video
                  controls
                  preload="metadata"
                  src={clip.file_url}
                  className="w-full h-full object-contain"
                />
              </div>
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 min-w-0">
                  <p className="text-body-sm text-moonbeem-ink truncate">
                    {displayLabel}
                  </p>
                  {duration && (
                    <span className="text-body-sm text-moonbeem-ink-subtle shrink-0">
                      · {duration}
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => handleDownload(clip)}
                  disabled={busyId === clip.id}
                  className="shrink-0 text-body-sm text-moonbeem-pink transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {busyId === clip.id ? "Downloading…" : downloadLabel()}
                </button>
              </div>
              {errorId === clip.id && (
                <p className="m-0 text-caption text-moonbeem-magenta">
                  Download failed. Try again.
                </p>
              )}
            </div>
          );
        })}
      </div>

      <GateModal
        open={!!gate}
        onClose={() => setGate(null)}
        reason={gate?.reason ?? "auth_required"}
        limit={gate?.limit}
        used={gate?.used}
        capabilityType="clips"
        returnTo={
          typeof window !== "undefined" ? window.location.pathname : "/"
        }
      />
    </>
  );
}
