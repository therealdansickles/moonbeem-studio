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
        className="rounded-md border border-moonbeem-pink px-4 py-2 text-body-sm font-semibold text-moonbeem-pink transition-colors hover:bg-moonbeem-pink hover:text-moonbeem-navy"
      >
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
