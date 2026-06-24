"use client";

// Partner-admin DRM uploader for a title (Unit 2b). Home: /p/[slug]/titles/[titleId].
// Drives the full lifecycle — upload (resumable, multi-GB) -> encode -> publish:
//   idle -> uploading X% -> processing (encode, minutes for a feature)
//        -> ready to publish -> published   (+ a SEPARATE "make title public").
//
// "Upload 100%" != "ready" != "published" — made unmistakable in the copy. After
// the PUT succeeds the asset still ENCODES; we poll the status route until
// 'ready', then a deliberate Publish flips the episode onto the Watch tab. Making
// the whole TITLE publicly listed is a separate control (Commit C), decoupled so
// nothing goes live by accident.
//
// The handoff: MuxUploader's `endpoint` async fn POSTs the create-upload route
// with the FILM TITLE as the label, stashes the jobId, returns the one-time Mux
// upload URL. Relative POST keeps Origin = current host for the cross-origin PUT.

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import TerritorySelector from "@/components/p/TerritorySelector";

// MuxUploader is a web component (registers a custom element, touches
// customElements/HTMLElement) — load it client-only via dynamic ssr:false,
// exactly as EpisodeModal loads MuxPlayer. Avoids the web-component SSR break.
const MuxUploader = dynamic(() => import("@mux/mux-uploader-react"), {
  ssr: false,
});

type Episode = {
  id: string;
  episode_number: number;
  label: string | null;
  source: string;
  is_published: boolean;
};

type Phase =
  | "idle"
  | "uploading"
  | "processing"
  | "ready"
  | "published"
  | "errored";

const POLL_MS = 4000;
const MAX_POLLS = 150; // ~10 min; a longer feature keeps encoding server-side

function publishError(code: string | undefined, status: number): string {
  switch (code) {
    case "not_ready":
      return "This video isn't finished processing yet.";
    case "episode_not_found":
      return "That asset no longer exists.";
    case "not_authorized":
      return "You don't have permission to publish here.";
    default:
      return code ?? `Couldn't publish (${status}).`;
  }
}

export default function TitleUploadPanel({
  titleId,
  filmTitle,
  isPublic,
  isPartnerAdmin,
  episodes,
  territoryWorldwide,
  allowedTerritories,
}: {
  titleId: string;
  titleSlug: string;
  filmTitle: string;
  isPublic: boolean;
  isPartnerAdmin: boolean;
  episodes: Episode[];
  territoryWorldwide: boolean;
  allowedTerritories: string[];
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState(0);
  const [jobId, setJobId] = useState<string | null>(null);
  const [episodeId, setEpisodeId] = useState<string | null>(null);
  const [slowEncode, setSlowEncode] = useState(false);
  const [publishingId, setPublishingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // "Make title public" — separate, deliberate go-live (Commit C).
  const [titlePublic, setTitlePublic] = useState(isPublic);
  const [confirmPublic, setConfirmPublic] = useState(false);
  const [makingPublic, setMakingPublic] = useState(false);
  const [publicError, setPublicError] = useState<string | null>(null);

  // Poll the status route while the asset encodes (processing -> ready/errored).
  useEffect(() => {
    if (phase !== "processing" || !jobId) return;
    let cancelled = false;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      if (cancelled) return;
      attempts += 1;
      try {
        const r = await fetch(
          `/api/titles/${titleId}/episodes/mux-jobs/${jobId}`,
        );
        if (r.ok) {
          const j = (await r.json()) as {
            status: string;
            error: string | null;
            episodeId: string | null;
          };
          if (cancelled) return;
          if (j.status === "ready") {
            setEpisodeId(j.episodeId);
            setPhase("ready");
            return;
          }
          if (j.status === "errored") {
            setError(j.error ?? "Encoding failed.");
            setPhase("errored");
            return;
          }
        }
      } catch {
        // transient network error — keep polling
      }
      if (cancelled) return;
      if (attempts >= MAX_POLLS) {
        // Encoding is still going server-side; the episode will appear on
        // reload. Stop polling but don't call it an error.
        setSlowEncode(true);
        return;
      }
      timer = setTimeout(poll, POLL_MS);
    }
    timer = setTimeout(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [phase, jobId, titleId]);

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
    setEpisodeId(null);
    setSlowEncode(false);
    setError(null);
  }

  async function publishEpisode(epId: string) {
    setPublishingId(epId);
    setError(null);
    try {
      const r = await fetch(
        `/api/titles/${titleId}/episodes/${epId}/publish`,
        { method: "POST" },
      );
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        setError(publishError(j.error, r.status));
        setPublishingId(null);
        return;
      }
      setPublishingId(null);
      if (epId === episodeId) setPhase("published");
      router.refresh(); // re-load the assets list with the now-published episode
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPublishingId(null);
    }
  }

  async function makeTitlePublic() {
    setMakingPublic(true);
    setPublicError(null);
    try {
      const r = await fetch(`/api/titles/${titleId}/publish`, {
        method: "POST",
      });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) {
        setPublicError(
          j.error === "no_published_asset"
            ? "Publish at least one video before making the title public."
            : j.error === "no_territories_set"
              ? "Set this title's territories above before making it public."
              : j.error === "title_not_active"
                ? "This title isn't active, so it can't be made public."
                : (j.error ?? `Couldn't make the title public (${r.status}).`),
        );
        setMakingPublic(false);
        return;
      }
      setTitlePublic(true);
      setConfirmPublic(false);
      setMakingPublic(false);
      router.refresh();
    } catch (e) {
      setPublicError(e instanceof Error ? e.message : String(e));
      setMakingPublic(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Existing assets — each unpublished mux asset can be published here too
          (the durable path that works on reload, not just right after upload). */}
      {episodes.length > 0 && (
        <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
          <p className="text-caption uppercase tracking-wide text-moonbeem-ink-muted m-0">
            Assets
          </p>
          <ul className="mt-3 flex flex-col gap-2">
            {episodes.map((ep) => {
              const publishable = ep.source === "mux" && !ep.is_published;
              return (
                <li
                  key={ep.id}
                  className="flex items-center justify-between gap-3 text-body-sm text-moonbeem-ink"
                >
                  <span className="min-w-0 truncate">
                    {ep.label ?? `Episode ${ep.episode_number}`}
                    <span className="ml-2 text-caption text-moonbeem-ink-subtle">
                      {ep.source}
                    </span>
                  </span>
                  {ep.is_published ? (
                    <span className="text-caption text-moonbeem-lime">
                      published
                    </span>
                  ) : publishable ? (
                    <button
                      type="button"
                      onClick={() => publishEpisode(ep.id)}
                      disabled={publishingId === ep.id}
                      className="rounded-md bg-moonbeem-pink px-3 py-1 text-caption font-semibold text-moonbeem-navy hover:opacity-90 disabled:opacity-40"
                    >
                      {publishingId === ep.id ? "Publishing…" : "Publish"}
                    </button>
                  ) : (
                    <span className="text-caption text-moonbeem-ink-subtle">
                      draft
                    </span>
                  )}
                </li>
              );
            })}
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
                // Uploaded; the asset now ENCODES. Poll begins (effect above).
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
                Uploading… {progress}% — don't close this tab until it reaches
                100%.
              </p>
            )}
          </div>
        )}

        {phase === "processing" && (
          <div className="mt-4 flex flex-col gap-2">
            <p className="text-body-sm font-medium text-moonbeem-ink m-0">
              {slowEncode ? "Still processing…" : "Processing…"}
            </p>
            <p className="text-caption text-moonbeem-ink-subtle m-0">
              {slowEncode
                ? "Encoding is taking a while — it continues in the background. Reload this page in a few minutes to publish the asset."
                : "Your video uploaded successfully and is now encoding (upload done ≠ ready). This can take several minutes for a long film — you can leave and come back."}
            </p>
          </div>
        )}

        {phase === "ready" && (
          <div className="mt-4 flex flex-col gap-3">
            <p className="text-body-sm font-medium text-moonbeem-ink m-0">
              Ready to publish
            </p>
            <p className="text-caption text-moonbeem-ink-subtle m-0">
              “{filmTitle}” finished encoding. Publishing makes it playable on the
              title's Watch tab (the title itself goes public separately).
            </p>
            {episodeId && (
              <button
                type="button"
                onClick={() => publishEpisode(episodeId)}
                disabled={publishingId === episodeId}
                className="w-fit rounded-md bg-moonbeem-pink px-4 py-2 text-caption font-semibold text-moonbeem-navy hover:opacity-90 disabled:opacity-40"
              >
                {publishingId === episodeId ? "Publishing…" : "Publish asset"}
              </button>
            )}
          </div>
        )}

        {phase === "published" && (
          <div className="mt-4 flex flex-col gap-2">
            <p className="text-body-sm font-medium text-moonbeem-lime m-0">
              Published
            </p>
            <p className="text-caption text-moonbeem-ink-subtle m-0">
              The asset is live on the title's Watch tab. Make the title itself
              publicly listed below when you're ready.
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

        {error && phase !== "errored" && (
          <p className="mt-3 text-caption text-moonbeem-magenta m-0">{error}</p>
        )}
      </div>

      {/* Territories — declare WHERE the film is licensed to play. Sits before
          Visibility because the publish route's no_territories_set guard requires
          it (and the playback helper default-denies an unset title). */}
      <TerritorySelector
        titleId={titleId}
        initialWorldwide={territoryWorldwide}
        initialAllowed={allowedTerritories}
      />

      {/* Make title public — a SEPARATE, deliberate go-live, intentionally
          decoupled from asset-publish so listing the film is one explicit
          decision (the route also guards: needs >=1 published asset + territories). */}
      <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
        <p className="text-caption uppercase tracking-wide text-moonbeem-ink-muted m-0">
          Visibility
        </p>
        {titlePublic ? (
          <p className="mt-3 text-body-sm text-moonbeem-ink m-0">
            <span className="text-moonbeem-lime">Public</span> — listed in the
            catalog and viewable by anyone.
          </p>
        ) : (
          <div className="mt-3 flex flex-col gap-3">
            <p className="text-body-sm text-moonbeem-ink m-0">
              Private draft — only your team can see this title.
            </p>
            {!confirmPublic ? (
              <button
                type="button"
                onClick={() => {
                  setConfirmPublic(true);
                  setPublicError(null);
                }}
                className="w-fit rounded-md border border-moonbeem-pink px-3 py-1.5 text-caption font-semibold text-moonbeem-pink transition-colors hover:bg-moonbeem-pink/10"
              >
                Make title public
              </button>
            ) : (
              <div className="flex flex-col gap-2">
                <p className="text-caption text-moonbeem-ink-subtle m-0">
                  This lists “{filmTitle}” in the public catalog and makes its
                  page viewable by anyone. It needs at least one published video.
                </p>
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={makeTitlePublic}
                    disabled={makingPublic}
                    className="rounded-md bg-moonbeem-pink px-4 py-2 text-caption font-semibold text-moonbeem-navy hover:opacity-90 disabled:opacity-40"
                  >
                    {makingPublic ? "Publishing…" : "Yes, make it public"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmPublic(false)}
                    disabled={makingPublic}
                    className="text-caption text-moonbeem-ink-subtle hover:text-moonbeem-ink"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
            {publicError && (
              <p className="text-caption text-moonbeem-magenta m-0">
                {publicError}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
