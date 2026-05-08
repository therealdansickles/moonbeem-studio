"use client";

import Link from "next/link";
import { useState } from "react";

type Props = {
  slug: string;
  title: string;
  initialIsActive: boolean;
  initialIsPublic: boolean;
  partnerName: string | null;
  partnerSlug: string | null;
  fanEditCount: number;
  totalViews: number;
  totalViewsFormatted: string;
};

type ActionState = "idle" | "saving" | "error";

function Toggle({
  on,
  disabled,
  onClick,
  label,
}: {
  on: boolean;
  disabled?: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={on}
      aria-label={label}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        on ? "bg-moonbeem-pink" : "bg-white/15"
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
          on ? "translate-x-6" : "translate-x-1"
        }`}
      />
    </button>
  );
}

export default function TitleRowControls({
  slug,
  title,
  initialIsActive,
  initialIsPublic,
  partnerName,
  partnerSlug,
  fanEditCount,
  totalViews,
  totalViewsFormatted,
}: Props) {
  const [isActive, setIsActive] = useState(initialIsActive);
  const [isPublic, setIsPublic] = useState(initialIsPublic);
  const [state, setState] = useState<ActionState>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  async function patch(payload: {
    is_active?: boolean;
    is_public?: boolean;
  }) {
    setState("saving");
    setErrorMsg(null);
    try {
      const res = await fetch(`/api/admin/titles/${slug}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        title?: { is_active: boolean; is_public: boolean };
        error?: string;
      };
      if (!res.ok || !json.ok || !json.title) {
        setErrorMsg(json.error ?? `request failed (${res.status})`);
        setState("error");
        // Roll back optimistic toggles.
        setIsActive(initialIsActive);
        setIsPublic(initialIsPublic);
        return;
      }
      setIsActive(json.title.is_active);
      setIsPublic(json.title.is_public);
      setState("idle");
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setState("error");
      setIsActive(initialIsActive);
      setIsPublic(initialIsPublic);
    }
  }

  function onToggleActive() {
    if (state === "saving") return;
    if (isActive) {
      // Confirm deactivation — partners may have campaigns running.
      const ok = window.confirm(
        `Deactivate "${title}"?\n\nThis pauses CPM payouts, hides it from the partner dashboard surfaces that filter on active titles, and (if Public is on) flips Public off too. Reactivating later restores the prior state.`,
      );
      if (!ok) return;
      // Optimistic, with rollback on error.
      setIsActive(false);
      setIsPublic(false);
      void patch({ is_active: false });
    } else {
      setIsActive(true);
      void patch({ is_active: true });
    }
  }

  function onTogglePublic() {
    if (state === "saving") return;
    if (!isActive) {
      setErrorMsg("Activate first — Public requires Active.");
      setState("error");
      return;
    }
    const next = !isPublic;
    setIsPublic(next);
    void patch({ is_public: next });
  }

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
      <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
        <div className="min-w-0 flex-1">
          <Link
            href={`/admin/titles/${slug}`}
            className="text-body font-medium text-moonbeem-ink hover:text-moonbeem-pink"
          >
            {title}
          </Link>
          <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-caption text-moonbeem-ink-subtle">
            {partnerSlug ? (
              <Link
                href={`/p/${partnerSlug}`}
                className="hover:text-moonbeem-pink"
              >
                Partner: {partnerName ?? partnerSlug}
              </Link>
            ) : (
              <span>No partner</span>
            )}
            <span>·</span>
            <span className="tabular-nums">
              {fanEditCount} {fanEditCount === 1 ? "edit" : "edits"}
            </span>
            <span>·</span>
            <span className="tabular-nums">
              {totalViewsFormatted} views
              <span className="sr-only"> ({totalViews})</span>
            </span>
          </div>
        </div>

        <div className="flex items-center gap-6">
          <label className="flex items-center gap-2 text-body-sm text-moonbeem-ink">
            <span className="text-moonbeem-ink-muted">Active</span>
            <Toggle
              on={isActive}
              disabled={state === "saving"}
              onClick={onToggleActive}
              label="Toggle active"
            />
          </label>
          <label
            className={`flex items-center gap-2 text-body-sm ${
              isActive ? "text-moonbeem-ink" : "text-moonbeem-ink-subtle"
            }`}
          >
            <span className={isActive ? "text-moonbeem-ink-muted" : ""}>
              Public
            </span>
            <Toggle
              on={isPublic}
              disabled={!isActive || state === "saving"}
              onClick={onTogglePublic}
              label="Toggle public"
            />
          </label>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3 text-caption">
        {partnerSlug && (
          <Link
            href={`/p/${partnerSlug}`}
            className="rounded-md border border-white/10 px-3 py-1 text-moonbeem-ink-muted hover:border-moonbeem-pink/40 hover:text-moonbeem-pink"
          >
            Partner dashboard →
          </Link>
        )}
        {isActive && isPublic && (
          <Link
            href={`/t/${slug}`}
            className="rounded-md border border-white/10 px-3 py-1 text-moonbeem-ink-muted hover:border-moonbeem-pink/40 hover:text-moonbeem-pink"
          >
            Public page →
          </Link>
        )}
        <Link
          href={`/admin/titles/${slug}`}
          className="rounded-md border border-white/10 px-3 py-1 text-moonbeem-ink-muted hover:border-moonbeem-pink/40 hover:text-moonbeem-pink"
        >
          Manage fan edits →
        </Link>
      </div>

      {errorMsg && (
        <p className="mt-3 text-caption text-moonbeem-magenta">{errorMsg}</p>
      )}
    </div>
  );
}
