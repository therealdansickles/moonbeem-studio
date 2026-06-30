"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Props = {
  hasAccount: boolean;
  onboardingCompleted: boolean;
  payoutsEnabled: boolean;
  availableCents: number;
  pendingCents: number;
  minimumCents: number;
  // Which withdraw producer to POST to. Defaults to the campaign rail so
  // existing campaign call sites are unchanged; the affiliate /me control
  // passes "/api/me/affiliate/withdraw". The onboard flow is shared (one
  // Connect account per creator), so it stays hardcoded to /payouts/onboard.
  withdrawPath?: string;
};

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export default function PayoutsControls({
  hasAccount,
  onboardingCompleted,
  payoutsEnabled,
  availableCents,
  pendingCents,
  minimumCents,
  withdrawPath = "/api/me/payouts/withdraw",
}: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function startOnboarding() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/me/payouts/onboard", { method: "POST" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.onboarding_url) {
        setError(json.error ?? `request failed (${res.status})`);
        setBusy(false);
        return;
      }
      // Stripe-hosted form. They redirect back to /me on completion.
      window.location.href = json.onboarding_url as string;
    } catch (err) {
      setError(err instanceof Error ? err.message : "network_error");
      setBusy(false);
    }
  }

  async function withdraw() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await fetch(withdrawPath, { method: "POST" });
      const json = await res.json().catch(() => ({}));
      // 202 reconciliation park: the transfer WAS initiated — the money moved
      // — but the ledger flip needs a manual check. This is NOT a failure, so
      // we must never tell the curator it failed. It's distinguished from a
      // real error by the needs_reconciliation flag (a real error is !ok
      // WITHOUT it, handled below). Show the producer's reassuring detail.
      if (res.status === 202 && json.needs_reconciliation) {
        setSuccess(
          (json.detail as string) ??
            "Your payout was sent and is being reconciled — no action needed.",
        );
        // Re-render with fresh server state (the parked withdrawal now blocks
        // re-entry, so the button correctly disappears).
        router.refresh();
        return;
      }
      if (!res.ok || !json.ok) {
        setError(json.error ?? `request failed (${res.status})`);
        return;
      }
      setSuccess(
        `${
          dollars(json.amount_cents as number)
        } sent. Stripe handles the bank transfer from here.`,
      );
      // Re-render with fresh server state.
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "network_error");
    } finally {
      setBusy(false);
    }
  }

  // Decide which button(s) and copy to render.
  if (!hasAccount) {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-caption text-moonbeem-ink-subtle">
          Set up payouts with Stripe to withdraw your earnings.
        </p>
        <button
          type="button"
          onClick={startOnboarding}
          disabled={busy}
          className="self-start rounded-md bg-moonbeem-pink px-4 py-2 text-body-sm font-semibold text-moonbeem-navy hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "Opening Stripe…" : "Set up payouts"}
        </button>
        {error && (
          <p className="text-caption text-moonbeem-magenta">{error}</p>
        )}
      </div>
    );
  }

  if (!onboardingCompleted || !payoutsEnabled) {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-caption text-moonbeem-ink-subtle">
          {!onboardingCompleted
            ? "Stripe onboarding isn't finished yet. Pick up where you left off."
            : "Stripe is verifying your account. Once verification finishes, withdrawals will unlock."}
        </p>
        {!onboardingCompleted && (
          <button
            type="button"
            onClick={startOnboarding}
            disabled={busy}
            className="self-start rounded-md bg-moonbeem-pink px-4 py-2 text-body-sm font-semibold text-moonbeem-navy hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? "Opening Stripe…" : "Complete payout setup"}
          </button>
        )}
        {error && (
          <p className="text-caption text-moonbeem-magenta">{error}</p>
        )}
      </div>
    );
  }

  if (pendingCents > 0) {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-body-sm text-moonbeem-ink">
          {dollars(pendingCents)} withdrawal in flight. Available again
          once Stripe confirms the transfer.
        </p>
      </div>
    );
  }

  const belowMinimum = availableCents < minimumCents;
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={withdraw}
        disabled={busy || belowMinimum}
        className="self-start rounded-md bg-moonbeem-pink px-4 py-2 text-body-sm font-semibold text-moonbeem-navy hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-30"
      >
        {busy
          ? "Sending…"
          : belowMinimum
          ? `Withdraw — min ${dollars(minimumCents)}`
          : `Withdraw ${dollars(availableCents)}`}
      </button>
      {belowMinimum && (
        <p className="text-caption text-moonbeem-ink-subtle">
          Available balance is below the {dollars(minimumCents)} minimum.
          Earnings continue to accrue daily.
        </p>
      )}
      {success && (
        <p className="text-caption text-emerald-300">{success}</p>
      )}
      {error && (
        <p className="text-caption text-moonbeem-magenta">{error}</p>
      )}
    </div>
  );
}
