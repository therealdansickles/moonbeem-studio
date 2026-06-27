"use client";

// Minimal "Buy for $X.XX" button (transactions sub-unit 4). Mirrors RentButton
// but POSTs kind='purchase' to the shared transact route (/api/titles/[id]/rent)
// and redirects to Stripe Checkout. A purchase is permanent (no clocks). Shown
// alongside RentButton when the title offers both; styled as an outline so the
// filled Rent CTA stays primary.

import { useState } from "react";
import GateModal from "@/components/gating/GateModal";

type AuthState = "anon" | "no_creator" | "ready";

export default function BuyButton({
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

  async function buy() {
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
      const res = await fetch(`/api/titles/${titleId}/rent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "purchase" }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        checkout_url?: string;
        already_entitled?: boolean;
        error?: string;
      };
      if (res.status === 401) {
        setMsg("Sign in to buy this film.");
        setLoading(false);
        return;
      }
      if (json.already_entitled) {
        setMsg("You already own this film.");
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
        onClick={buy}
        disabled={loading}
        className="rounded-md border border-moonbeem-pink bg-transparent px-4 py-2.5 text-body-sm font-semibold text-moonbeem-pink transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {loading ? "Starting checkout…" : `Buy for $${dollars}`}
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
