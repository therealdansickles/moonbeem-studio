"use client";

// Subscribe / manage affordance for the Hosting section. Free creators see the
// paid tiers as upgrade buttons (→ Stripe Checkout); subscribed creators see a
// single "Manage plan" button (→ Stripe Billing Portal, where upgrade/downgrade/
// cancel live). Both routes return a Stripe-hosted URL we redirect to; NO money
// value is handled client-side.

import { useState } from "react";

type Tier = "free" | "solo" | "studio" | "pro";

const PAID: { tier: Exclude<Tier, "free">; label: string; price: number; minutes: number }[] = [
  { tier: "solo", label: "Solo", price: 15, minutes: 600 },
  { tier: "studio", label: "Studio", price: 39, minutes: 2400 },
  { tier: "pro", label: "Pro", price: 99, minutes: 9000 },
];

export default function HostingTierControls({ tier }: { tier: Tier }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function go(path: string, bodyTier?: string) {
    setBusy(bodyTier ?? "manage");
    setError(null);
    try {
      const r = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: bodyTier ? JSON.stringify({ tier: bodyTier }) : undefined,
      });
      const j = (await r.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!r.ok || !j.url) {
        setError(j.error ?? `Couldn't open billing (${r.status}).`);
        setBusy(null);
        return;
      }
      window.location.href = j.url; // Stripe-hosted Checkout / Portal
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  }

  if (tier !== "free") {
    // Subscribed: one door to Stripe's portal for upgrade/downgrade/cancel.
    return (
      <div className="mt-3 flex flex-col gap-2">
        <button
          type="button"
          onClick={() => go("/api/me/hosting/billing-portal")}
          disabled={busy !== null}
          className="w-fit rounded-md border border-white/15 bg-white/5 px-3 py-1.5 text-caption text-moonbeem-ink-muted transition-colors hover:border-moonbeem-pink hover:text-moonbeem-pink disabled:opacity-40"
        >
          {busy === "manage" ? "Opening…" : "Manage plan"}
        </button>
        {error && <p className="text-caption text-moonbeem-magenta m-0">{error}</p>}
      </div>
    );
  }

  // Free: offer the paid tiers.
  return (
    <div className="mt-3 flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {PAID.map((p) => (
          <button
            key={p.tier}
            type="button"
            onClick={() => go("/api/me/hosting/subscribe", p.tier)}
            disabled={busy !== null}
            className="rounded-md border border-moonbeem-pink px-3 py-1.5 text-caption font-semibold text-moonbeem-pink transition-colors hover:bg-moonbeem-pink/10 disabled:opacity-40"
          >
            {busy === p.tier
              ? "Opening…"
              : `${p.label} — $${p.price}/mo · ${(p.minutes / 60) | 0}h`}
          </button>
        ))}
      </div>
      {error && <p className="text-caption text-moonbeem-magenta m-0">{error}</p>}
    </div>
  );
}
