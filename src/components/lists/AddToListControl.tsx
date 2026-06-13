"use client";

// Phase 1D — "Add to list" header control. Same three auth branches as
// LogControl; ready → opens the ListPickerModal.

import { useState } from "react";
import Link from "next/link";
import GateModal from "@/components/gating/GateModal";
import ListPickerModal from "@/components/lists/ListPickerModal";

type AuthState = "anon" | "no_creator" | "ready";

export default function AddToListControl({
  titleId,
  titleName,
  authState,
  returnTo,
}: {
  titleId: string;
  titleName: string;
  authState: AuthState;
  returnTo: string;
}) {
  const [open, setOpen] = useState(false);
  const [gateOpen, setGateOpen] = useState(false);
  const [showNudge, setShowNudge] = useState(false);

  function onClick() {
    if (authState === "anon") {
      setGateOpen(true);
      return;
    }
    if (authState === "no_creator") {
      setShowNudge(true);
      return;
    }
    setOpen(true);
  }

  return (
    <div className="flex flex-col items-center gap-1 md:items-start">
      <button
        type="button"
        onClick={onClick}
        className="inline-flex items-center gap-1.5 rounded-md border border-white/15 px-3 py-1.5 text-body-sm font-medium text-moonbeem-ink-muted transition-colors hover:border-moonbeem-pink hover:text-moonbeem-pink"
      >
        <svg
          viewBox="0 0 24 24"
          width={15}
          height={15}
          aria-hidden="true"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 5v14M5 12h14" />
        </svg>
        Add to list
      </button>

      {showNudge && authState === "no_creator" && (
        <p className="m-0 text-body-sm text-moonbeem-ink-muted">
          <Link
            href={`/onboarding/handle?next=${encodeURIComponent(returnTo)}`}
            className="text-moonbeem-pink hover:opacity-90"
          >
            Claim a Moonbeem handle to make lists →
          </Link>
        </p>
      )}

      {authState === "anon" && (
        <GateModal
          open={gateOpen}
          onClose={() => setGateOpen(false)}
          reason="auth_required"
          returnTo={returnTo}
        />
      )}

      {open && authState === "ready" && (
        <ListPickerModal
          titleId={titleId}
          titleName={titleName}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}
