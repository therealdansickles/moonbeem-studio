"use client";

// Partner-admin "Add a title" entry — the first step of the film-upload flow.
// Creates a NOT-publicly-live draft title under the partner via
// POST /api/p/[slug]/titles (which derives partner_id from the path, never the
// body). A later unit's DRM uploader attaches the asset; this form stops at
// "draft created". The parent only renders this for partner-admins (isPartnerAdmin),
// and the route re-verifies membership server-side regardless. Client island —
// the rest of the partner dashboard is server-rendered.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

const MEDIA_TYPES: ReadonlyArray<{ value: string; label: string; hint: string }> = [
  { value: "movie", label: "Film", hint: "feature or short" },
  { value: "tv", label: "Series", hint: "episodes" },
  { value: "event", label: "Event", hint: "a one-off" },
];

// Hosting axis (orthogonal to the format above): how the title is delivered.
// 'film' uploads a DRM video here; 'embed' is an Instagram/social title whose
// episodes are pasted in on the admin Settings page.
const CONTENT_KINDS: ReadonlyArray<{ value: string; label: string; hint: string }> = [
  { value: "film", label: "Film upload", hint: "DRM video" },
  { value: "embed", label: "Instagram embed", hint: "social reels" },
];

const TITLE_MAX_LENGTH = 200;

function friendlyError(code: string | undefined, status: number): string {
  switch (code) {
    case "title_required":
      return "Enter a title name.";
    case "title_too_long":
      return `Title must be ${TITLE_MAX_LENGTH} characters or fewer.`;
    case "invalid_media_type":
      return "Pick a valid type.";
    case "invalid_content_kind":
      return "Pick a valid hosting option.";
    case "invalid_year":
      return "Enter a valid year (1870–2100).";
    case "invalid_runtime":
      return "Enter a valid runtime in minutes.";
    case "not_found":
      return "You don't have access to add titles here.";
    case "not_authenticated":
      return "Please sign in again.";
    default:
      return code ?? `Couldn't create the title (${status}).`;
  }
}

export default function AddTitleForm({ partnerSlug }: { partnerSlug: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [mediaType, setMediaType] = useState("movie");
  const [contentKind, setContentKind] = useState("film");
  const [year, setYear] = useState("");
  const [runtime, setRuntime] = useState("");
  const [synopsis, setSynopsis] = useState("");
  const [phase, setPhase] = useState<"idle" | "saving">("idle");
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ title: string; id: string } | null>(
    null,
  );

  const busy = phase === "saving";

  async function submit() {
    setError(null);
    setPhase("saving");
    try {
      const res = await fetch(`/api/p/${partnerSlug}/titles`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Body carries ONLY descriptive fields — the route ignores any partner_id
        // and derives ownership from the [slug] path.
        body: JSON.stringify({
          title,
          media_type: mediaType,
          content_kind: contentKind,
          year: year.trim() ? Number(year) : undefined,
          runtime_min: runtime.trim() ? Number(runtime) : undefined,
          synopsis: synopsis.trim() || undefined,
        }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        error?: string;
        title?: { id: string; title: string; slug: string };
      };
      if (!res.ok || !json.title) {
        setError(friendlyError(json.error, res.status));
        setPhase("idle");
        return;
      }
      setCreated({ title: json.title.title, id: json.title.id });
      setTitle("");
      setYear("");
      setRuntime("");
      setSynopsis("");
      setMediaType("movie");
      setContentKind("film");
      setOpen(false);
      setPhase("idle");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("idle");
    }
  }

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="rounded-full bg-moonbeem-violet/20 px-2.5 py-0.5 text-caption font-medium text-moonbeem-violet-soft">
            Catalog
          </span>
          <span className="text-caption text-moonbeem-ink-subtle">
            Add a film, short, or series to your catalog
          </span>
        </div>
        {!open && (
          <button
            type="button"
            onClick={() => {
              setOpen(true);
              setCreated(null);
            }}
            className="rounded-md bg-moonbeem-pink px-3 py-1.5 text-caption font-semibold text-moonbeem-navy hover:opacity-90"
          >
            Add a title
          </button>
        )}
      </div>

      {created && !open && (
        <p className="mt-4 text-body-sm text-moonbeem-ink m-0">
          Created <span className="font-medium">“{created.title}”</span> as a
          private draft.{" "}
          <Link
            href={`/p/${partnerSlug}/titles/${created.id}`}
            className="font-medium text-moonbeem-pink hover:underline"
          >
            Upload a video →
          </Link>
        </p>
      )}

      {open && (
        <div className="mt-5 flex flex-col gap-4">
          <label className="flex flex-col gap-1.5">
            <span className="text-caption text-moonbeem-ink-muted">Title</span>
            <input
              type="text"
              value={title}
              maxLength={TITLE_MAX_LENGTH}
              onChange={(e) => setTitle(e.target.value)}
              disabled={busy}
              placeholder="e.g. Erupcja"
              className="rounded-md border border-white/10 bg-black/30 px-3 py-2 text-body-sm text-moonbeem-ink focus:border-moonbeem-pink focus:outline-none disabled:opacity-60"
            />
          </label>

          <div className="flex flex-col gap-1.5">
            <span className="text-caption text-moonbeem-ink-muted">Type</span>
            <div className="flex flex-wrap gap-2">
              {MEDIA_TYPES.map((m) => (
                <button
                  key={m.value}
                  type="button"
                  onClick={() => setMediaType(m.value)}
                  disabled={busy}
                  className={`rounded-md border px-3 py-1.5 text-body-sm transition-colors disabled:opacity-60 ${
                    mediaType === m.value
                      ? "border-moonbeem-pink bg-moonbeem-pink/10 text-moonbeem-pink"
                      : "border-white/10 text-moonbeem-ink-muted hover:border-moonbeem-pink"
                  }`}
                >
                  {m.label}{" "}
                  <span className="text-caption text-moonbeem-ink-subtle">
                    · {m.hint}
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-caption text-moonbeem-ink-muted">Hosting</span>
            <div className="flex flex-wrap gap-2">
              {CONTENT_KINDS.map((c) => (
                <button
                  key={c.value}
                  type="button"
                  onClick={() => setContentKind(c.value)}
                  disabled={busy}
                  className={`rounded-md border px-3 py-1.5 text-body-sm transition-colors disabled:opacity-60 ${
                    contentKind === c.value
                      ? "border-moonbeem-pink bg-moonbeem-pink/10 text-moonbeem-pink"
                      : "border-white/10 text-moonbeem-ink-muted hover:border-moonbeem-pink"
                  }`}
                >
                  {c.label}{" "}
                  <span className="text-caption text-moonbeem-ink-subtle">
                    · {c.hint}
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap gap-4">
            <label className="flex flex-col gap-1.5">
              <span className="text-caption text-moonbeem-ink-muted">
                Year (optional)
              </span>
              <input
                type="number"
                value={year}
                onChange={(e) => setYear(e.target.value)}
                disabled={busy}
                placeholder="2026"
                className="w-28 rounded-md border border-white/10 bg-black/30 px-3 py-2 text-body-sm text-moonbeem-ink tabular-nums focus:border-moonbeem-pink focus:outline-none disabled:opacity-60"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-caption text-moonbeem-ink-muted">
                Runtime min (optional)
              </span>
              <input
                type="number"
                value={runtime}
                onChange={(e) => setRuntime(e.target.value)}
                disabled={busy}
                placeholder="104"
                className="w-32 rounded-md border border-white/10 bg-black/30 px-3 py-2 text-body-sm text-moonbeem-ink tabular-nums focus:border-moonbeem-pink focus:outline-none disabled:opacity-60"
              />
            </label>
          </div>

          <label className="flex flex-col gap-1.5">
            <span className="text-caption text-moonbeem-ink-muted">
              Synopsis (optional)
            </span>
            <textarea
              value={synopsis}
              onChange={(e) => setSynopsis(e.target.value)}
              disabled={busy}
              rows={3}
              placeholder="A short description…"
              className="rounded-md border border-white/10 bg-black/30 px-3 py-2 text-body-sm text-moonbeem-ink focus:border-moonbeem-pink focus:outline-none disabled:opacity-60"
            />
          </label>

          <p className="text-caption text-moonbeem-ink-subtle m-0">
            The title is created as a private draft — not publicly live until you
            upload a video and it's reviewed.
          </p>

          {error && (
            <p className="text-caption text-moonbeem-magenta m-0">{error}</p>
          )}

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={submit}
              disabled={busy || !title.trim()}
              className="rounded-md bg-moonbeem-pink px-4 py-2 text-caption font-semibold text-moonbeem-navy hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-30"
            >
              {busy ? "Creating…" : "Create title"}
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setError(null);
              }}
              disabled={busy}
              className="text-caption text-moonbeem-ink-subtle hover:text-moonbeem-ink"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
