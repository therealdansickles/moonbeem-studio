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
function HostedTitleCard({ hostedTitle }: { hostedTitle: HostedTitle }) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState(0);
  const [jobId, setJobId] = useState<string | null>(null);
  const [slowEncode, setSlowEncode] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
          {hostedTitle.episodes.map((ep) => (
            <li
              key={ep.id}
              className="flex items-center justify-between gap-3 text-body-sm text-moonbeem-ink"
            >
              <span className="min-w-0 truncate">
                {ep.label ?? `Episode ${ep.episode_number}`}
              </span>
              <span className="text-caption text-moonbeem-lime">hosted</span>
            </li>
          ))}
        </ul>
      )}

      {(phase === "idle" || phase === "uploading") && (
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

export default function HostingSection({
  hostedTitles,
}: {
  hostedTitles: HostedTitle[];
}) {
  return (
    <div className="flex flex-col gap-6">
      <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
        <p className="text-caption uppercase tracking-wide text-moonbeem-ink-muted m-0">
          Host a film
        </p>
        <p className="mt-3 text-body-sm text-moonbeem-ink-muted m-0">
          Upload your films to Moonbeem — encoded and stored with DRM
          protection. Create the film, then upload its video below.
        </p>
        <HostFilmForm />
      </div>

      {hostedTitles.map((t) => (
        <HostedTitleCard key={t.id} hostedTitle={t} />
      ))}
    </div>
  );
}
