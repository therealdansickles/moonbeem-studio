"use client";

// Phase 1A — the "Your rating" control on the title header. Client child of
// the server title page (like OfferButtonClient). Three auth states resolved
// server-side and passed in:
//   "ready"      → interactive StarRatingInput bound to POST/DELETE, optimistic
//   "no_creator" → on interact, an inline nudge into the handle funnel
//   "anon"       → on interact, the GateModal (auth_required)
//
// No toast library — failures revert the optimistic value and show inline text.

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { StarRatingInput } from "@/components/StarRating";
import GateModal from "@/components/gating/GateModal";

type AuthState = "anon" | "no_creator" | "ready";

export default function TitleRatingControl({
  titleId,
  initialRating,
  authState,
  returnTo,
}: {
  titleId: string;
  initialRating: number | null;
  authState: AuthState;
  returnTo: string;
}) {
  const [rating, setRating] = useState<number | null>(initialRating);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gateOpen, setGateOpen] = useState(false);
  const [showNudge, setShowNudge] = useState(false);
  const router = useRouter();

  async function submit(next: number) {
    const prev = rating;
    setRating(next); // optimistic
    setError(null);
    setPending(true);
    try {
      const res = await fetch("/api/me/ratings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title_id: titleId, rating: next }),
      });
      if (!res.ok) {
        setRating(prev);
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setError(j.error ?? "Couldn't save your rating.");
      } else {
        // Re-render the server component so the public aggregate
        // (titles.rating_avg/_count) reflects the new rating — including the
        // first rating, which the count>0 gate otherwise hides until reload.
        router.refresh();
      }
    } catch {
      setRating(prev);
      setError("Couldn't save your rating.");
    } finally {
      setPending(false);
    }
  }

  async function clear() {
    const prev = rating;
    setRating(null); // optimistic
    setError(null);
    setPending(true);
    try {
      const res = await fetch("/api/me/ratings", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title_id: titleId }),
      });
      if (!res.ok) {
        setRating(prev);
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setError(j.error ?? "Couldn't clear your rating.");
      } else {
        router.refresh();
      }
    } catch {
      setRating(prev);
      setError("Couldn't clear your rating.");
    } finally {
      setPending(false);
    }
  }

  function onChange(next: number) {
    if (authState === "anon") {
      setGateOpen(true);
      return;
    }
    if (authState === "no_creator") {
      setShowNudge(true);
      return;
    }
    void submit(next);
  }

  return (
    <div className="flex flex-col items-center gap-1 md:items-start">
      <div className="flex items-center gap-3">
        <span className="text-body-sm text-moonbeem-ink-subtle">
          Your rating
        </span>
        <StarRatingInput
          value={authState === "ready" ? rating : null}
          onChange={onChange}
          disabled={pending}
          size={24}
        />
        {authState === "ready" && rating != null && (
          <button
            type="button"
            onClick={() => void clear()}
            disabled={pending}
            className="text-body-sm text-moonbeem-ink-subtle transition-colors hover:text-moonbeem-pink disabled:opacity-50"
          >
            Clear
          </button>
        )}
      </div>

      {error && <p className="m-0 text-body-sm text-moonbeem-magenta">{error}</p>}

      {showNudge && authState === "no_creator" && (
        <p className="m-0 text-body-sm text-moonbeem-ink-muted">
          <Link
            href={`/onboarding/handle?next=${encodeURIComponent(returnTo)}`}
            className="text-moonbeem-pink hover:opacity-90"
          >
            Claim a Moonbeem handle to rate →
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
