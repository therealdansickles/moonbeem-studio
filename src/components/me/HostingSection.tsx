"use client";

// /me Hosting — the creator self-serve hosting lane's dashboard section. v1 is
// dashboard-only (ruling Q2): create → upload → encode → hosted. No public
// page, no publish/visibility controls — Phase 6 owns going public.
//
// The uploader lifecycle here — dynamic ssr:false MuxUploader, endpoint-POST →
// one-time upload URL, poll-until-ready with the slow-encode fallback, the
// "upload 100% ≠ ready" copy — is inherited WHOLE from the partner
// TitleUploadPanel (src/components/p/TitleUploadPanel.tsx), retargeted at the
// /api/me/hosting/* routes. The partner panel itself is untouched.

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import HostingTierControls from "./HostingTierControls";
import CreatorEpisodePreview from "./CreatorEpisodePreview";

// MuxUploader is a web component (registers a custom element, touches
// customElements/HTMLElement) — load it client-only via dynamic ssr:false,
// exactly as TitleUploadPanel and EpisodeModal do. Avoids the web-component
// SSR break.
const MuxUploader = dynamic(() => import("@mux/mux-uploader-react"), {
  ssr: false,
});

export type HostedEpisode = {
  id: string;
  episode_number: number;
  label: string | null;
};

export type HostedTitle = {
  id: string;
  title: string;
  episodes: HostedEpisode[];
  // Server-derived status of the latest non-ready ingest job for this title
  // (null = none). Makes an in-flight encode visible after a reload — without
  // it the card would show a fresh uploader and invite a duplicate upload.
  jobStatus: { status: "processing" | "errored"; error: string | null } | null;
};

type Phase = "idle" | "uploading" | "processing" | "ready" | "errored";

const POLL_MS = 4000;
const MAX_POLLS = 150; // ~10 min; a longer film keeps encoding server-side

function createError(code: string | undefined, status: number): string {
  switch (code) {
    case "title_required":
      return "Give your film a title first.";
    case "title_too_long":
      return "That title is too long (200 characters max).";
    case "no_claimed_creator":
      return "Claim your Moonbeem handle before hosting films.";
    case "rate_limited":
      return "Too many requests — give it a minute and try again.";
    default:
      return code ?? `Couldn't create the film (${status}).`;
  }
}

// "Host a film" — creates the creator_title the uploader below attaches to.
// On success the new film arrives via router.refresh() (server-rendered with
// its own uploader card), so no client-side list state to reconcile.
function HostFilmForm() {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    const trimmed = title.trim();
    if (!trimmed || creating) return;
    setCreating(true);
    setError(null);
    try {
      const r = await fetch("/api/me/hosting/titles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: trimmed }),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        setError(createError(j.error, r.status));
        setCreating(false);
        return;
      }
      setTitle("");
      setCreating(false);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setCreating(false);
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void create();
      }}
      className="mt-4 flex flex-col gap-3"
    >
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Film title"
          maxLength={200}
          className="w-full rounded-md border border-white/15 bg-white/5 px-3 py-2 text-body-sm text-moonbeem-ink placeholder:text-moonbeem-ink-subtle focus:border-moonbeem-pink focus:outline-none sm:max-w-sm"
        />
        <button
          type="submit"
          disabled={creating || !title.trim()}
          className="shrink-0 rounded-md bg-moonbeem-pink px-4 py-2 text-body-sm font-semibold text-moonbeem-navy hover:opacity-90 disabled:opacity-40"
        >
          {creating ? "Creating…" : "Create film"}
        </button>
      </div>
      {error && (
        <p className="text-caption text-moonbeem-magenta m-0">{error}</p>
      )}
    </form>
  );
}

// One hosted film: its hosted assets + the whole inherited uploader lifecycle
// (idle → uploading X% → processing → hosted). "Ready" here means HOSTED —
// encoded and stored with DRM — there is no publish step in v1.
function HostedTitleCard({
  hostedTitle,
  atCeiling,
}: {
  hostedTitle: HostedTitle;
  atCeiling: boolean;
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState(0);
  const [jobId, setJobId] = useState<string | null>(null);
  const [slowEncode, setSlowEncode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Which hosted episode is expanded into the self-preview player (fetch-on-play
  // — a token is minted only when the owner clicks Preview). Null = none open.
  const [previewEpisodeId, setPreviewEpisodeId] = useState<string | null>(null);

  // Server-derived in-flight state (from the last non-ready ingest job).
  // Only consulted when THIS tab isn't mid-lifecycle (phase 'idle') — a live
  // upload/encode in this tab always wins. A job encoding in another tab (or
  // after a reload) surfaces here as processing, suppressing the uploader so
  // the creator doesn't start a duplicate upload; an errored prior job shows
  // its message but still lets them try again.
  const serverProcessing =
    phase === "idle" && hostedTitle.jobStatus?.status === "processing";
  const serverErrored =
    phase === "idle" && hostedTitle.jobStatus?.status === "errored";

  // Poll the status route while the asset encodes (processing →
  // ready/errored). Inherited whole from TitleUploadPanel — same cadence,
  // same slow-encode stop-without-erroring.
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
          `/api/me/hosting/titles/${hostedTitle.id}/mux-jobs/${jobId}`,
        );
        if (r.ok) {
          const j = (await r.json()) as {
            status: string;
            error: string | null;
            episodeId: string | null;
          };
          if (cancelled) return;
          if (j.status === "ready") {
            setPhase("ready");
            router.refresh(); // pull the new hosted asset into the list below
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
        // Encoding is still going server-side; the asset will appear on
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
  }, [phase, jobId, hostedTitle.id, router]);

  function reset() {
    setPhase("idle");
    setProgress(0);
    setJobId(null);
    setSlowEncode(false);
    setError(null);
  }

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-body font-medium text-moonbeem-ink m-0 min-w-0 truncate">
          {hostedTitle.title}
        </p>
        <span className="text-caption text-moonbeem-ink-subtle">
          {hostedTitle.episodes.length === 0
            ? "no video yet"
            : hostedTitle.episodes.length === 1
              ? "1 hosted video"
              : `${hostedTitle.episodes.length} hosted videos`}
        </span>
      </div>

      {hostedTitle.episodes.length > 0 && (
        <ul className="mt-3 flex flex-col gap-2">
          {hostedTitle.episodes.map((ep) => {
            const previewing = previewEpisodeId === ep.id;
            return (
              <li key={ep.id} className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-3 text-body-sm text-moonbeem-ink">
                  <span className="min-w-0 truncate">
                    {ep.label ?? `Episode ${ep.episode_number}`}
                  </span>
                  <div className="flex shrink-0 items-center gap-3">
                    <span className="text-caption text-moonbeem-lime">
                      hosted
                    </span>
                    {/* Preview — owner-only playback of a ready hosted asset. Every
                        listed episode is finalized (ready), so the affordance is
                        always live here; in-flight encodes render as jobStatus, not
                        as episodes, so no dead-end Preview is ever shown. */}
                    <button
                      type="button"
                      onClick={() =>
                        setPreviewEpisodeId(previewing ? null : ep.id)
                      }
                      className="rounded-md border border-white/15 bg-white/5 px-2.5 py-1 text-caption text-moonbeem-ink-muted transition-colors hover:border-moonbeem-pink hover:text-moonbeem-pink"
                    >
                      {previewing ? "Close" : "Preview"}
                    </button>
                  </div>
                </div>
                {previewing && (
                  <div className="overflow-hidden rounded-lg bg-black/40">
                    <CreatorEpisodePreview
                      titleId={hostedTitle.id}
                      episodeId={ep.id}
                    />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {/* An encode is in flight (this title has a non-ready job) but this tab
          isn't the one running it — after a reload, or a second tab. Show it
          as processing and DON'T offer the uploader, so no duplicate upload. */}
      {serverProcessing && (
        <div className="mt-4 flex flex-col gap-2">
          <p className="text-body-sm font-medium text-moonbeem-ink m-0">
            Processing…
          </p>
          <p className="text-caption text-moonbeem-ink-subtle m-0">
            A video for this film is still encoding (upload done ≠ ready). This
            can take several minutes for a long film — reload in a bit to see it
            once it&apos;s hosted.
          </p>
        </div>
      )}

      {/* A prior ingest job errored and this tab isn't mid-lifecycle — surface
          it, but still offer the uploader below so they can try again. */}
      {serverErrored && (
        <p className="mt-4 text-caption text-moonbeem-magenta m-0">
          The last upload for this film didn&apos;t finish
          {hostedTitle.jobStatus?.error
            ? `: ${hostedTitle.jobStatus.error}`
            : "."}{" "}
          You can upload again below.
        </p>
      )}

      {/* At the plan ceiling: block starting a new upload on this title too,
          with the same honest upgrade nudge. Existing playback is untouched. */}
      {atCeiling && phase === "idle" && !serverProcessing && (
        <p className="mt-4 text-caption text-moonbeem-pink m-0">
          You&apos;re at your plan&apos;s minute limit — upgrade to upload more.
        </p>
      )}

      {((phase === "idle" && !serverProcessing && !atCeiling) ||
        phase === "uploading") && (
        <div className="mt-4">
          <MuxUploader
            endpoint={async () => {
              setError(null);
              const r = await fetch(
                `/api/me/hosting/titles/${hostedTitle.id}/mux-upload`,
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ label: hostedTitle.title }),
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
              Uploading… {progress}% — don&apos;t close this tab until it
              reaches 100%.
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
              ? "Encoding is taking a while — it continues in the background. Reload this page in a few minutes to see the hosted video."
              : "Your video uploaded successfully and is now encoding (upload done ≠ ready). This can take several minutes for a long film — you can leave and come back."}
          </p>
        </div>
      )}

      {phase === "ready" && (
        <div className="mt-4 flex flex-col gap-3">
          <p className="text-body-sm font-medium text-moonbeem-lime m-0">
            Hosted
          </p>
          <p className="text-caption text-moonbeem-ink-subtle m-0">
            &ldquo;{hostedTitle.title}&rdquo; finished encoding and is stored
            with DRM protection.
          </p>
          <button
            type="button"
            onClick={reset}
            className="w-fit rounded-md border border-white/10 px-3 py-1.5 text-caption text-moonbeem-ink-muted transition-colors hover:border-moonbeem-pink hover:text-moonbeem-pink"
          >
            Upload another video
          </button>
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
  );
}

// The tier + usage line (Phase 3). Sentence case, NO progress bar (ruling D4 —
// a bar implies a hard cap; the ceiling is soft). Shows the plan and the
// billable minutes (used minus the permanent-zero grandfathered floor) against
// the allotment, with an honest note for grandfathered minutes.
export type HostingStatusProps = {
  tier: "free" | "solo" | "studio" | "pro";
  allotmentMinutes: number;
  billableMinutes: number;
  grandfatheredFloorMinutes: number;
  atCeiling: boolean;
  pendingCancel: boolean;
  cancelAt: string | null;
};

// Deterministic UTC date for the pending-cancel line (matches Stripe's date,
// and UTC pins it so SSR and client render identically — no hydration drift).
function formatCancelDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

const TIER_LABEL: Record<HostingStatusProps["tier"], string> = {
  free: "Free",
  solo: "Solo",
  studio: "Studio",
  pro: "Pro",
};

function tierLine(s: HostingStatusProps): string {
  const used = Math.round(s.billableMinutes);
  const base = `You're on the ${TIER_LABEL[s.tier]} plan. ${used} of ${s.allotmentMinutes} minutes used.`;
  const gf = Math.round(s.grandfatheredFloorMinutes);
  return gf > 0
    ? `${base} Your ${gf} earlier ${gf === 1 ? "minute" : "minutes"} are grandfathered free.`
    : base;
}

export default function HostingSection({
  hostedTitles,
  status,
}: {
  hostedTitles: HostedTitle[];
  status: HostingStatusProps;
}) {
  return (
    <div className="flex flex-col gap-6">
      <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
        <p className="text-caption uppercase tracking-wide text-moonbeem-ink-muted m-0">
          Host a film
        </p>
        <p className="mt-3 text-body-sm text-moonbeem-ink-muted m-0">
          Upload your films to Moonbeem. They&apos;re encoded and stored with
          protected, DRM-backed playback. Create the film, then upload its video
          below.
        </p>
        <p className="mt-2 text-caption text-moonbeem-ink-subtle m-0 tabular-nums">
          {tierLine(status)}
        </p>
        {status.pendingCancel && (
          <p className="mt-1 text-caption text-moonbeem-ink-subtle m-0">
            {status.cancelAt
              ? `Cancels ${formatCancelDate(status.cancelAt)}.`
              : "Cancels at the end of the billing period."}
          </p>
        )}
        <HostingTierControls tier={status.tier} />

        {status.atCeiling ? (
          // Soft ceiling (ruling D4): new uploads are blocked with an honest
          // upgrade prompt — existing films keep playing, nothing is taken down.
          <p className="mt-4 text-caption text-moonbeem-pink m-0">
            You&apos;ve reached your {TIER_LABEL[status.tier]} plan&apos;s{" "}
            {status.allotmentMinutes}-minute limit. Upgrade above to host more —
            your existing films keep playing.
          </p>
        ) : (
          <HostFilmForm />
        )}
      </div>

      {hostedTitles.map((t) => (
        <HostedTitleCard
          key={t.id}
          hostedTitle={t}
          atCeiling={status.atCeiling}
        />
      ))}

      {/* Deferred-remedy honesty: v1 has no self-serve delete (Phase 6 ships
          it — Q2 dashboard-only). Until then, a hosted film can only be taken
          down by us, so we say so plainly and give the contact path. */}
      {hostedTitles.length > 0 && (
        <p className="text-caption text-moonbeem-ink-subtle m-0">
          Need to remove a hosted film? Email{" "}
          <a
            href="mailto:hello@moonbeem.xyz?subject=Remove%20a%20hosted%20film"
            className="text-moonbeem-ink-muted hover:text-moonbeem-pink"
          >
            hello@moonbeem.xyz
          </a>
          . Self-serve deletion is on the way.
        </p>
      )}
    </div>
  );
}
