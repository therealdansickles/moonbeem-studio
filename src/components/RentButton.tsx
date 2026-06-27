"use client";

// Minimal "Rent for $X.XX" button (transactions sub-unit 2). POSTs to
// /api/titles/[id]/rent and redirects to Stripe Checkout. TEMPORARY: the polished
// rent-vs-play gate (showing Rent vs playing for an entitled viewer) is sub-unit
// 3 — this is just enough to drive the money-rail test.

import { useState } from "react";
import GateModal from "@/components/gating/GateModal";

type AuthState = "anon" | "no_creator" | "ready";

export default function RentButton({
  titleId,
  priceCents,
  authState,
  returnTo,
}: {
  titleId: string;
  priceCents: number;
  authState: AuthState;
  returnTo: string;
}) {
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [gateOpen, setGateOpen] = useState(false);
  const dollars = (priceCents / 100).toFixed(2); // display only

  async function rent() {
    // Anon viewers hit the sign-in gate BEFORE any charge POST, mirroring the
    // library controls. The 401 branch below is now an unreachable defensive
    // fallback for an anon click (kept intentionally; removing it is out of scope).
    if (authState === "anon") {
      setGateOpen(true);
      return;
    }
    setLoading(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/titles/${titleId}/rent`, { method: "POST" });
      const json = (await res.json().catch(() => ({}))) as {
        checkout_url?: string;
        already_entitled?: boolean;
        error?: string;
      };
      if (res.status === 401) {
        setMsg("Sign in to rent this film.");
        setLoading(false);
        return;
      }
      if (json.already_entitled) {
        setMsg("You've already rented this — playback arrives in the next update.");
        setLoading(false);
        return;
      }
      if (json.checkout_url) {
        window.location.href = json.checkout_url;
        return; // leaving the page; keep the spinner
      }
      setMsg(
        json.error
          ? `Couldn't start checkout (${json.error}).`
          : "Couldn't start checkout.",
      );
      setLoading(false);
    } catch {
      setMsg("Couldn't start checkout.");
      setLoading(false);
    }
  }

  return (
    <div className="flex w-full max-w-sm flex-col gap-2">
      <button
        type="button"
        onClick={rent}
        disabled={loading}
        className="rounded-md bg-moonbeem-pink px-4 py-2.5 text-body-sm font-semibold text-moonbeem-navy transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {loading ? "Starting checkout…" : `Rent for $${dollars}`}
      </button>
      {msg && (
        <p className="text-caption text-moonbeem-ink-subtle m-0">{msg}</p>
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
