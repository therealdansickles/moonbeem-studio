"use client";

// Controlled confirmation dialog for destructive (or restorable)
// actions on admin surfaces. Replaces window.confirm so the message
// can include rich copy, the look matches the dark/pink palette, and
// the consumer keeps full control of the async + error flow.
//
// Pattern: parent owns open state + the row context being acted on.
// Modal renders only when isOpen is true; Escape and outside-click
// route back to onCancel.

import { useEffect } from "react";

type Tone = "destructive" | "primary";

type Props = {
  isOpen: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  /** Optional second paragraph, used to spell out reversibility etc. */
  detail?: string;
  /** destructive = magenta confirm button; primary = pink confirm button. */
  tone?: Tone;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

export default function ConfirmModal({
  isOpen,
  title,
  description,
  confirmLabel,
  detail,
  tone = "destructive",
  busy = false,
  onConfirm,
  onCancel,
}: Props) {
  useEffect(() => {
    if (!isOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !busy) onCancel();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isOpen, busy, onCancel]);

  if (!isOpen) return null;

  const confirmClass =
    tone === "destructive"
      ? "bg-moonbeem-magenta text-white hover:opacity-90"
      : "bg-moonbeem-pink text-moonbeem-navy hover:opacity-90";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
    >
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-moonbeem-black p-6 shadow-2xl">
        <h2
          id="confirm-modal-title"
          className="m-0 font-wordmark text-heading-md text-moonbeem-pink"
        >
          {title}
        </h2>
        <p className="mt-3 text-body-sm text-moonbeem-ink">{description}</p>
        {detail && (
          <p className="mt-2 text-caption text-moonbeem-ink-subtle">
            {detail}
          </p>
        )}
        <div className="mt-6 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-md border border-white/10 px-4 py-2 text-body-sm text-moonbeem-ink-muted hover:border-moonbeem-pink hover:text-moonbeem-pink disabled:cursor-not-allowed disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className={`rounded-md px-5 py-2 text-body-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50 ${confirmClass}`}
          >
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
