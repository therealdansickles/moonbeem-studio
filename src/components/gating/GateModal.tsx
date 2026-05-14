"use client";

// Gating Phase 1 — the gate-hit modal. Appears when canPerform()
// denies an action, with a clear unlock CTA. Three variants keyed on
// `reason`; follows the ConfirmModal pattern (dark/pink palette, ESC
// + outside-click dismiss).
//
// The primary CTA carries the current path through as redirect_to /
// return_to so the user lands back where they were after signing in
// or verifying — they then re-take the action naturally.

import { useEffect } from "react";
import Link from "next/link";

type GateReason =
  | "auth_required"
  | "verification_required"
  | "limit_reached";

type Props = {
  open: boolean;
  onClose: () => void;
  reason: GateReason;
  limit?: number;
  used?: number;
  /** Which noun the limit_reached copy uses. */
  capabilityType?: "clips" | "stills";
  /** Current path — preserved through the sign-in / verify redirect. */
  returnTo: string;
};

export default function GateModal({
  open,
  onClose,
  reason,
  limit,
  used,
  capabilityType,
  returnTo,
}: Props) {
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const encoded = encodeURIComponent(returnTo);
  const noun = capabilityType ?? "clips";

  let title: string;
  let body: string;
  let primaryLabel: string;
  let primaryHref: string;

  if (reason === "auth_required") {
    title = "Sign in to continue";
    body =
      "To save titles, download content, and access your top 12, you need a Moonbeem account.";
    primaryLabel = "Sign in →";
    primaryHref = `/login?redirect_to=${encoded}`;
  } else if (reason === "verification_required") {
    title = "Verify a social handle";
    body =
      "Uploading fan edits, downloading all clips, and earning from your work all require a verified social account.";
    primaryLabel = "Verify a handle →";
    primaryHref = `/me/edit?return_to=${encoded}`;
  } else {
    title = "You've used your free downloads";
    body = `You've downloaded ${used ?? 0} of ${limit ?? 0} free ${noun}. Verify a social handle to download all ${noun} and unlock more features.`;
    primaryLabel = "Verify a handle →";
    primaryHref = `/me/edit?return_to=${encoded}`;
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="gate-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-moonbeem-black p-6 shadow-2xl">
        <h2
          id="gate-modal-title"
          className="m-0 font-wordmark text-heading-md text-moonbeem-pink"
        >
          {title}
        </h2>
        <p className="mt-3 text-body-sm text-moonbeem-ink leading-relaxed">
          {body}
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-white/10 px-4 py-2 text-body-sm text-moonbeem-ink-muted transition-colors hover:border-moonbeem-pink hover:text-moonbeem-pink"
          >
            Maybe later
          </button>
          <Link
            href={primaryHref}
            className="rounded-md bg-moonbeem-pink px-5 py-2 text-body-sm font-semibold text-moonbeem-navy transition-opacity hover:opacity-90"
          >
            {primaryLabel}
          </Link>
        </div>
      </div>
    </div>
  );
}
