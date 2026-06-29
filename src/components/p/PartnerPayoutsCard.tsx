"use client";

// Partner dashboard payouts card — mirrors the creator onboarding UI
// (src/components/me/PayoutsControls.tsx) for partners. INERT in B1: it only
// onboards a Stripe Connect account and reflects its state. No balances, no
// withdraw (that's B2). Rendered only for partner admins (the page gates the
// mount); the status/onboard routes are independently admin-gated.

import { useEffect, useState } from "react";

type Props = { slug: string };

type Status = {
  has_account: boolean;
  onboarding_completed: boolean;
  payouts_enabled: boolean;
};

const BTN_CLASS =
  "self-start rounded-md bg-moonbeem-violet px-4 py-2 text-body-sm font-semibold text-moonbeem-ink hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50";

export default function PartnerPayoutsCard({ slug }: Props) {
  const [status, setStatus] = useState<Status | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Fetch account state on load (mirrors the status route's shape).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/p/${slug}/payouts/status`);
        const json = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) {
          setLoadError(json.error ?? `request failed (${res.status})`);
          return;
        }
        setStatus({
          has_account: !!json.has_account,
          onboarding_completed: !!json.onboarding_completed,
          payouts_enabled: !!json.payouts_enabled,
        });
      } catch (err) {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : "network_error");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug]);

  async function startOnboarding() {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      const res = await fetch(`/api/p/${slug}/payouts/onboard`, {
        method: "POST",
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.onboarding_url) {
        setActionError(json.error ?? `request failed (${res.status})`);
        setBusy(false);
        return;
      }
      // Stripe-hosted form; redirects back to this dashboard on completion.
      window.location.href = json.onboarding_url as string;
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "network_error");
      setBusy(false);
    }
  }

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
      <div className="flex items-center gap-3">
        <span className="rounded-full bg-moonbeem-violet/20 px-2.5 py-0.5 text-caption font-medium text-moonbeem-violet-soft">
          Payouts
        </span>
        <span className="text-caption text-moonbeem-ink-subtle">
          Stripe Connect · receive distribution earnings
        </span>
      </div>

      <div className="mt-4">
        {loadError && (
          <p className="text-caption text-moonbeem-magenta">{loadError}</p>
        )}
        {!loadError && status === null && (
          <p className="text-caption text-moonbeem-ink-subtle">Loading…</p>
        )}
        {!loadError && status !== null && !status.has_account && (
          <div className="flex flex-col gap-2">
            <p className="text-caption text-moonbeem-ink-subtle">
              Set up payouts with Stripe to receive your distribution earnings.
            </p>
            <button
              type="button"
              onClick={startOnboarding}
              disabled={busy}
              className={BTN_CLASS}
            >
              {busy ? "Opening Stripe…" : "Set up payouts"}
            </button>
            {actionError && (
              <p className="text-caption text-moonbeem-magenta">{actionError}</p>
            )}
          </div>
        )}
        {!loadError &&
          status !== null &&
          status.has_account &&
          (!status.onboarding_completed || !status.payouts_enabled) && (
            <div className="flex flex-col gap-2">
              <p className="text-caption text-moonbeem-ink-subtle">
                {!status.onboarding_completed
                  ? "Stripe onboarding isn't finished yet. Pick up where you left off."
                  : "Stripe is verifying your account. Payouts unlock once verification finishes."}
              </p>
              {!status.onboarding_completed && (
                <button
                  type="button"
                  onClick={startOnboarding}
                  disabled={busy}
                  className={BTN_CLASS}
                >
                  {busy ? "Opening Stripe…" : "Complete payout setup"}
                </button>
              )}
              {actionError && (
                <p className="text-caption text-moonbeem-magenta">
                  {actionError}
                </p>
              )}
            </div>
          )}
        {!loadError &&
          status !== null &&
          status.has_account &&
          status.onboarding_completed &&
          status.payouts_enabled && (
            <p className="text-body-sm text-moonbeem-ink">Payouts enabled.</p>
          )}
      </div>
    </div>
  );
}
