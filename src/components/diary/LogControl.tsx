"use client";

// Phase 1C — unified "Log or review" entry control in the title header
// (replaces 1B's WriteReviewControl). Same three auth branches as
// TitleRatingControl: ready → open the log modal; no_creator → handle-funnel
// nudge; anon → GateModal.

import { useState } from "react";
import Link from "next/link";
import GateModal from "@/components/gating/GateModal";
import LogModal from "@/components/diary/LogModal";

type AuthState = "anon" | "no_creator" | "ready";

export default function LogControl({
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
  const [modalOpen, setModalOpen] = useState(false);
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
    setModalOpen(true);
  }

  return (
    <div className="flex flex-col items-center gap-1 md:items-start">
      <button
        type="button"
        onClick={onClick}
        className="rounded-md border border-moonbeem-pink px-4 py-2 text-body-sm font-semibold text-moonbeem-pink transition-colors hover:bg-moonbeem-pink hover:text-moonbeem-navy"
      >
        Log or review
      </button>

      {showNudge && authState === "no_creator" && (
        <p className="m-0 text-body-sm text-moonbeem-ink-muted">
          <Link
            href={`/onboarding/handle?next=${encodeURIComponent(returnTo)}`}
            className="text-moonbeem-pink hover:opacity-90"
          >
            Claim a Moonbeem handle to log watches →
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

      {modalOpen && authState === "ready" && (
        <LogModal
          titleId={titleId}
          titleName={titleName}
          onClose={() => setModalOpen(false)}
        />
      )}
    </div>
  );
}
