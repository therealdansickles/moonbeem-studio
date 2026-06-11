"use client";

// Phase 1D — bookmark-style watchlist toggle in the title header. Same three
// auth branches as LogControl (ready/no_creator/anon). Optimistic flip; revert
// + inline error on failure.

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import GateModal from "@/components/gating/GateModal";

type AuthState = "anon" | "no_creator" | "ready";

export default function WatchlistToggle({
  titleId,
  initialOn,
  authState,
  returnTo,
}: {
  titleId: string;
  initialOn: boolean;
  authState: AuthState;
  returnTo: string;
}) {
  const [on, setOn] = useState(initialOn);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gateOpen, setGateOpen] = useState(false);
  const [showNudge, setShowNudge] = useState(false);
  const router = useRouter();

  async function toggle() {
    if (authState === "anon") {
      setGateOpen(true);
      return;
    }
    if (authState === "no_creator") {
      setShowNudge(true);
      return;
    }
    if (pending) return;
    const next = !on;
    setOn(next); // optimistic
    setError(null);
    setPending(true);
    try {
      const res = await fetch("/api/me/watchlist", {
        method: next ? "POST" : "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title_id: titleId }),
      });
      if (!res.ok) {
        setOn(!next);
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setError(j.error ?? "Couldn't update your watchlist.");
      } else {
        // Re-derive the server-resolved state. The toggle is keyed on it in the
        // page, so this keeps the header in sync even when the ListPickerModal
        // changes the watchlist out-of-band.
        router.refresh();
      }
    } catch {
      setOn(!next);
      setError("Couldn't update your watchlist.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col items-center gap-1 md:items-start">
      <button
        type="button"
        onClick={toggle}
        disabled={pending}
        aria-pressed={on}
        className={`inline-flex items-center gap-2 rounded-md border px-4 py-2 text-body-sm font-semibold transition-colors disabled:opacity-50 ${
          on
            ? "border-moonbeem-pink bg-moonbeem-pink/10 text-moonbeem-pink"
            : "border-moonbeem-pink text-moonbeem-pink hover:bg-moonbeem-pink hover:text-moonbeem-navy"
        }`}
      >
        <svg
          viewBox="0 0 24 24"
          width={15}
          height={15}
          aria-hidden="true"
          fill={on ? "currentColor" : "none"}
          stroke="currentColor"
          strokeWidth={2}
          strokeLinejoin="round"
        >
          <path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1z" />
        </svg>
        {on ? "On watchlist" : "Watchlist"}
      </button>

      {error && <p className="m-0 text-body-sm text-moonbeem-magenta">{error}</p>}

      {showNudge && authState === "no_creator" && (
        <p className="m-0 text-body-sm text-moonbeem-ink-muted">
          <Link
            href={`/onboarding/handle?next=${encodeURIComponent(returnTo)}`}
            className="text-moonbeem-pink hover:opacity-90"
          >
            Claim a Moonbeem handle to use your watchlist →
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
    </div>
  );
}
