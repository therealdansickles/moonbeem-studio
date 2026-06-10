"use client";

// Phase 1C — the unified "Log a watch" modal (generalizes 1B's ReviewModal).
// AddToTop12Modal precedent (inline z-50, ESC + outside-click). A log needs
// only a watched_on date; rating + review + spoiler + rewatch are optional —
// a review is just a log that carries text. Submit → POST /api/me/diary →
// optimistic close + router.refresh; inline error on failure.

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { StarRatingInput } from "@/components/StarRating";

const MAX_REVIEW_LEN = 10000;

export default function LogModal({
  titleId,
  titleName,
  onClose,
}: {
  titleId: string;
  titleName: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const today = new Date().toISOString().slice(0, 10);
  const [rating, setRating] = useState<number | null>(null);
  const [watchedOn, setWatchedOn] = useState<string>(today);
  const [text, setText] = useState("");
  const [spoilers, setSpoilers] = useState(false);
  const [rewatch, setRewatch] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Synchronous in-flight latch — `disabled={busy}` only applies after the next
  // render, so two fast clicks could double-POST (diary has no uniqueness).
  const inFlight = useRef(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !busy) onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

  const trimmed = text.trim();

  async function submit() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/me/diary", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title_id: titleId,
          rating: rating ?? undefined,
          watched_on: watchedOn,
          review_text: trimmed.length > 0 ? trimmed : undefined,
          contains_spoilers: trimmed.length > 0 ? spoilers : false,
          rewatch,
        }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setError(j.error ?? "Couldn't save your log.");
        setBusy(false);
        inFlight.current = false;
        return;
      }
      onClose(); // optimistic close
      router.refresh();
    } catch {
      setError("Couldn't save your log.");
      setBusy(false);
      inFlight.current = false;
    }
  }

  const inputClass =
    "rounded-md border border-moonbeem-border-strong bg-transparent px-4 py-3 text-body text-moonbeem-ink placeholder:text-moonbeem-ink-subtle focus:border-moonbeem-pink focus:outline-none";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Log a watch for ${titleName}`}
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/70 px-4 pt-20 backdrop-blur-sm"
      onClick={() => {
        if (!busy) onClose();
      }}
    >
      <div
        className="w-full max-w-lg rounded-2xl border border-white/10 bg-moonbeem-black/95 p-6 shadow-2xl shadow-black/60"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3">
          <h2 className="m-0 font-wordmark text-heading-md text-moonbeem-ink">
            Log a watch
          </h2>
          <button
            type="button"
            onClick={() => !busy && onClose()}
            aria-label="Close"
            className="rounded-md px-2 py-1 text-body-sm text-moonbeem-ink-subtle hover:text-moonbeem-ink"
          >
            ✕
          </button>
        </div>
        <p className="mt-1 text-body-sm text-moonbeem-ink-subtle">{titleName}</p>

        <div className="mt-5 flex flex-col gap-4">
          <div className="flex items-center gap-3">
            <span className="text-body-sm text-moonbeem-ink-muted">Rating</span>
            <StarRatingInput value={rating} onChange={setRating} size={24} />
            {rating != null && (
              <button
                type="button"
                onClick={() => setRating(null)}
                className="text-body-sm text-moonbeem-ink-subtle hover:text-moonbeem-pink"
              >
                Clear
              </button>
            )}
          </div>

          <label className="flex flex-col gap-1">
            <span className="text-body-sm text-moonbeem-ink-muted">
              Watched on
            </span>
            <input
              type="date"
              value={watchedOn}
              max={today}
              onChange={(e) => setWatchedOn(e.target.value)}
              className={inputClass}
            />
          </label>

          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={rewatch}
              onChange={(e) => setRewatch(e.target.checked)}
              className="accent-moonbeem-pink"
            />
            <span className="text-body-sm text-moonbeem-ink-muted">
              I&apos;ve watched this before
            </span>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-body-sm text-moonbeem-ink-muted">
              Review <span className="text-moonbeem-ink-subtle">(optional)</span>
            </span>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={5}
              maxLength={MAX_REVIEW_LEN}
              placeholder="Add a review…"
              className={inputClass}
            />
            {trimmed.length > 0 && (
              <span className="self-end text-caption text-moonbeem-ink-subtle">
                {trimmed.length}/{MAX_REVIEW_LEN}
              </span>
            )}
          </label>

          {trimmed.length > 0 && (
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={spoilers}
                onChange={(e) => setSpoilers(e.target.checked)}
                className="accent-moonbeem-pink"
              />
              <span className="text-body-sm text-moonbeem-ink-muted">
                This review contains spoilers
              </span>
            </label>
          )}

          {error && (
            <p className="m-0 text-body-sm text-moonbeem-magenta">{error}</p>
          )}

          <div className="flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={() => !busy && onClose()}
              className="rounded-md border border-white/10 px-4 py-2 text-body-sm text-moonbeem-ink-muted transition-colors hover:border-moonbeem-pink hover:text-moonbeem-pink"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={busy}
              className="rounded-md bg-moonbeem-pink px-5 py-2 text-body-sm font-semibold text-moonbeem-navy transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? "Saving…" : "Save to diary"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
