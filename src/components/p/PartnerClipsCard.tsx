"use client";

// Partner-admin per-clip rename UI. Lists the partner's clips grouped by their
// owned titles and lets an admin set each clip's display name, calling the
// ownership-checked PATCH /api/p/[slug]/clips/[id] (body: { label } only — the
// endpoint derives title_id/partner from the clip server-side). Styling mirrors
// PartnerRatesCard; no new design tokens. Reads no money data.

import { useRouter } from "next/navigation";
import { useState } from "react";

type ClipLite = {
  id: string;
  file_url: string | null;
  label: string | null;
};

type TitleClips = {
  title_id: string;
  title: string;
  clips: ClipLite[];
};

type Props = {
  partnerSlug: string;
  isAdmin: boolean;
  titles: TitleClips[];
};

// Mirrors VideosTab's fileNameFromUrl (basename of the R2 URL). Kept local so
// this card never imports — nor changes — the public render.
function fileNameFromUrl(url: string | null): string {
  if (!url) return "clip";
  try {
    return new URL(url).pathname.split("/").pop() || "clip";
  } catch {
    return url.split("/").pop() || "clip";
  }
}

// Same effective-name rule the public Clips tab uses: label, else filename.
function effectiveName(label: string | null, fileUrl: string | null): string {
  return label?.trim() || fileNameFromUrl(fileUrl);
}

const LABEL_MAX_LENGTH = 200;

function friendlyError(code: string | undefined, status: number): string {
  switch (code) {
    case "label_too_long":
      return `Name must be ${LABEL_MAX_LENGTH} characters or fewer.`;
    case "invalid_label":
      return "Enter a valid name.";
    case "clip_not_found":
      return "This clip no longer exists.";
    case "clip_not_in_partner":
    case "not_authorized":
      return "You don't have permission to rename this clip.";
    default:
      return code ?? `Couldn't save the name (${status}).`;
  }
}

export default function PartnerClipsCard({
  partnerSlug,
  isAdmin,
  titles,
}: Props) {
  // Single-title partners (e.g. 1-2 Special) default their one group OPEN so the
  // clips show without an extra click; multi-title partners default all groups
  // COLLAPSED — a tidy list of expandable title headers. ClipGroup seeds its own
  // open state from this.
  const defaultOpen = titles.length === 1;
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
      <div className="flex items-center gap-3">
        <span className="rounded-full bg-moonbeem-violet/20 px-2.5 py-0.5 text-caption font-medium text-moonbeem-violet-soft">
          Clips
        </span>
        <span className="text-caption text-moonbeem-ink-subtle">
          Rename clips on your titles
        </span>
      </div>

      <div className="mt-6 flex flex-col gap-3">
        {titles.map((t) => (
          <ClipGroup
            key={t.title_id}
            title={t.title}
            clips={t.clips}
            partnerSlug={partnerSlug}
            isAdmin={isAdmin}
            defaultOpen={defaultOpen}
          />
        ))}
      </div>

      {!isAdmin && (
        <p className="mt-4 text-caption text-moonbeem-ink-subtle">
          You have viewer access to this partner. Contact an admin to rename
          clips.
        </p>
      )}
    </div>
  );
}

const PAGE_SIZE = 10;

// One collapsible per-title group. Collapse is CONTROLLED (useState seeded from
// defaultOpen, synced via onToggle) and pagination is local state — both keyed by
// the stable key={title_id} at the call site, so a rename's router.refresh()
// (which re-renders with fresh props but does NOT unmount this component)
// preserves both the open state and the current page. Slice-only pagination
// (clips.slice) is intentional: off-page ClipRows unmount and an unsaved edit
// reverts — a minor, self-signaling edge (the Save button shows unsaved state).
function ClipGroup({
  title,
  clips,
  partnerSlug,
  isAdmin,
  defaultOpen,
}: {
  title: string;
  clips: ClipLite[];
  partnerSlug: string;
  isAdmin: boolean;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [page, setPage] = useState(0);

  const total = clips.length;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  // Clamp in case the clip count shrinks under us (e.g. a deletion elsewhere).
  const safePage = Math.min(page, pageCount - 1);
  const start = safePage * PAGE_SIZE;
  const visible = clips.slice(start, start + PAGE_SIZE);

  return (
    <details
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
      className="rounded-2xl border border-white/10 bg-white/[0.02] p-5"
    >
      <summary className="cursor-pointer text-body-sm font-medium text-moonbeem-ink">
        {title}{" "}
        <span className="font-normal text-moonbeem-ink-subtle">({total})</span>
      </summary>

      <div className="mt-4 flex flex-col gap-3">
        {visible.map((c) => (
          <ClipRow
            key={c.id}
            partnerSlug={partnerSlug}
            isAdmin={isAdmin}
            clipId={c.id}
            fileUrl={c.file_url}
            initialLabel={c.label}
          />
        ))}
      </div>

      {total > PAGE_SIZE && (
        <div className="mt-4 flex items-center justify-between gap-3">
          <span className="text-caption text-moonbeem-ink-subtle tabular-nums">
            Showing {start + 1}–{Math.min(start + PAGE_SIZE, total)} of {total}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setPage(safePage - 1)}
              disabled={safePage === 0}
              className="rounded-md border border-white/10 px-3 py-1.5 text-caption text-moonbeem-ink-muted transition-colors hover:border-moonbeem-pink hover:text-moonbeem-pink disabled:cursor-not-allowed disabled:opacity-30"
            >
              Prev
            </button>
            <button
              type="button"
              onClick={() => setPage(safePage + 1)}
              disabled={safePage >= pageCount - 1}
              className="rounded-md border border-white/10 px-3 py-1.5 text-caption text-moonbeem-ink-muted transition-colors hover:border-moonbeem-pink hover:text-moonbeem-pink disabled:cursor-not-allowed disabled:opacity-30"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </details>
  );
}

function ClipRow({
  partnerSlug,
  isAdmin,
  clipId,
  fileUrl,
  initialLabel,
}: {
  partnerSlug: string;
  isAdmin: boolean;
  clipId: string;
  fileUrl: string | null;
  initialLabel: string | null;
}) {
  const router = useRouter();
  const [input, setInput] = useState<string>(initialLabel ?? "");
  const [savedLabel, setSavedLabel] = useState<string | null>(initialLabel);
  const [phase, setPhase] = useState<"idle" | "saving" | "done">("idle");
  const [error, setError] = useState<string | null>(null);

  const busy = phase === "saving";
  // Compare trimmed input to the saved label (empty -> null), matching the
  // endpoint's normalization, so "no change" is detected the same way.
  const normalized = input.trim().length > 0 ? input.trim() : null;
  const dirty = normalized !== savedLabel;
  const currentName = effectiveName(savedLabel, fileUrl);

  async function save() {
    setError(null);
    setPhase("saving");
    try {
      const res = await fetch(`/api/p/${partnerSlug}/clips/${clipId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        // Body carries ONLY label — the endpoint derives title_id/partner.
        body: JSON.stringify({ label: input }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        error?: string;
        label?: string | null;
      };
      if (!res.ok) {
        setError(friendlyError(json.error, res.status));
        setPhase("idle");
        return;
      }
      setSavedLabel(json.label ?? null);
      router.refresh();
      setPhase("done");
      setTimeout(() => setPhase("idle"), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("idle");
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-white/5 bg-white/[0.02] px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="truncate text-body-sm text-moonbeem-ink">
          {currentName}
        </div>
        <div className="text-caption text-moonbeem-ink-subtle">
          Leave blank to use the filename
        </div>
      </div>
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={input}
          maxLength={LABEL_MAX_LENGTH}
          onChange={(e) => setInput(e.target.value)}
          disabled={!isAdmin || busy}
          placeholder="Display name"
          className="w-48 rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-body-sm text-moonbeem-ink focus:border-moonbeem-pink focus:outline-none disabled:opacity-60"
        />
        {isAdmin && (
          <button
            type="button"
            onClick={save}
            disabled={!dirty || busy}
            className="rounded-md bg-moonbeem-pink px-3 py-1.5 text-caption font-semibold text-moonbeem-navy hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-30"
          >
            {phase === "saving" ? "Saving…" : phase === "done" ? "Saved" : "Save"}
          </button>
        )}
      </div>
      {error && (
        <p className="basis-full text-caption text-moonbeem-magenta">{error}</p>
      )}
    </div>
  );
}
