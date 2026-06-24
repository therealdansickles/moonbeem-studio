"use client";

// Partner-admin DRM uploader for a title (Unit 2b). Home: /p/[slug]/titles/[titleId].
// Drives the full lifecycle — upload (resumable, multi-GB) -> encode -> publish:
//   idle -> uploading X% -> processing (encode, minutes for a feature)
//        -> ready to publish -> published   (+ a SEPARATE "make title public").
//
// The handoff: MuxUploader's `endpoint` is an async function that POSTs our
// create-upload route (with the FILM TITLE as the episode label, so a feature's
// one asset isn't "Episode 1"), captures the jobId, and returns the one-time Mux
// upload URL. The browser then PUTs the file straight to Mux. The POST uses a
// RELATIVE url so its Origin is the current host — the same host the PUT comes
// from — which is what Mux's cors_origin echo requires.
//
// (Commit A: upload + progress + processing. Commit B adds status polling +
// ready/published + the Publish button. Commit C adds "make title public".)

import MuxUploader from "@mux/mux-uploader-react";
import { useState } from "react";

type Episode = {
  id: string;
  episode_number: number;
  label: string | null;
  source: string;
  is_published: boolean;
};

type Phase = "idle" | "uploading" | "processing" | "ready" | "published" | "errored";

export default function TitleUploadPanel({
  titleId,
  filmTitle,
  isPartnerAdmin,
  episodes,
}: {
  titleId: string;
  titleSlug: string;
  filmTitle: string;
  isPublic: boolean;
  isPartnerAdmin: boolean;
  episodes: Episode[];
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState(0);
  const [, setJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!isPartnerAdmin) {
    return (
      <p className="text-body-sm text-moonbeem-ink-subtle m-0">
        You have viewer access to this partner. Ask an admin to upload or publish.
      </p>
    );
  }

  function reset() {
    setPhase("idle");
    setProgress(0);
    setJobId(null);
    setError(null);
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Existing assets */}
      {episodes.length > 0 && (
        <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
          <p className="text-caption uppercase tracking-wide text-moonbeem-ink-muted m-0">
            Assets
          </p>
          <ul className="mt-3 flex flex-col gap-2">
            {episodes.map((ep) => (
              <li
                key={ep.id}
                className="flex items-center justify-between gap-3 text-body-sm text-moonbeem-ink"
              >
                <span className="truncate">
                  {ep.label ?? `Episode ${ep.episode_number}`}
                  <span className="ml-2 text-caption text-moonbeem-ink-subtle">
                    {ep.source}
                  </span>
                </span>
                <span
                  className={`text-caption ${
                    ep.is_published
                      ? "text-moonbeem-lime"
                      : "text-moonbeem-ink-subtle"
                  }`}
                >
                  {ep.is_published ? "published" : "draft"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Uploader / lifecycle */}
      <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
        <p className="text-caption uppercase tracking-wide text-moonbeem-ink-muted m-0">
          Upload a video
        </p>

        {(phase === "idle" || phase === "uploading") && (
          <div className="mt-4">
            <MuxUploader
              // Async endpoint: mint the upload URL on file-pick, stash the
              // jobId, return the URL for the resumable PUT. Relative POST →
              // Origin = current host (CORS-safe for the cross-origin Mux PUT).
              endpoint={async () => {
                setError(null);
                const r = await fetch(
                  `/api/titles/${titleId}/episodes/mux-upload`,
                  {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ label: filmTitle }),
                  },
                );
                if (!r.ok) {
                  setError("Couldn't start the upload. Please try again.");
                  setPhase("errored");
                  throw new Error("upload_init_failed");
                }
                const json = (await r.json()) as {
                  jobId: string;
                  uploadUrl: string;
                };
                setJobId(json.jobId);
                return json.uploadUrl;
              }}
              onUploadStart={() => {
                setPhase("uploading");
                setProgress(0);
              }}
              onProgress={(e) => {
                const pct = Number((e as CustomEvent).detail);
                setProgress(Number.isFinite(pct) ? Math.round(pct) : 0);
              }}
              onSuccess={() => {
                // The file is uploaded; the asset now ENCODES (minutes for a
                // feature). Commit B polls the status route from here.
                setPhase("processing");
              }}
              onUploadError={() => {
                setError("The upload failed. Please try again.");
                setPhase("errored");
              }}
              className="block"
            />
            {phase === "uploading" && (
              <p className="mt-3 text-caption text-moonbeem-ink-subtle tabular-nums m-0">
                Uploading… {progress}%
              </p>
            )}
          </div>
        )}

        {phase === "processing" && (
          <div className="mt-4 flex flex-col gap-2">
            <p className="text-body-sm font-medium text-moonbeem-ink m-0">
              Processing…
            </p>
            <p className="text-caption text-moonbeem-ink-subtle m-0">
              Your video uploaded successfully and is now encoding. This can take
              several minutes for a long film — you can leave this page and come
              back.
            </p>
          </div>
        )}

        {phase === "errored" && (
          <div className="mt-4 flex flex-col gap-3">
            <p className="text-caption text-moonbeem-magenta m-0">
              {error ?? "Something went wrong."}
            </p>
            <button
              type="button"
              onClick={reset}
              className="w-fit rounded-md border border-white/10 px-3 py-1.5 text-caption text-moonbeem-ink-muted transition-colors hover:border-moonbeem-pink hover:text-moonbeem-pink"
            >
              Try again
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
