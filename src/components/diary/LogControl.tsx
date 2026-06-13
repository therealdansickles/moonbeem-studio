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
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
        </svg>
        Log
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
