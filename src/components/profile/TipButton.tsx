"use client";

// Tip button + amount sheet on the creator profile (non-owner, claimed creators
// only — the profile page renders the full view solely for claimed creators, and
// this sits in the non-owner header slot). Chips + custom field, optional
// message; posts to the tip checkout and hands off to Stripe. Zero platform fee:
// the creator keeps 100% of every tip.

import { useState } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import {
  TIP_PRESET_CENTS,
  MIN_TIP_CENTS,
  MAX_TIP_CENTS,
  validateTipAmountCents,
} from "@/lib/tips/amount";

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
}

export default function TipButton({
  creatorId,
  creatorName,
}: {
  creatorId: string;
  creatorName: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const justTipped = searchParams.get("tip") === "success";

  const [open, setOpen] = useState(false);
  const [selectedCents, setSelectedCents] = useState<number | null>(
    TIP_PRESET_CENTS[0],
  );
  const [customDollars, setCustomDollars] = useState("");
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const customCents = (() => {
    const raw = customDollars.trim();
    if (!raw) return null;
    const n = Number.parseFloat(raw);
    if (!Number.isFinite(n)) return null;
    return Math.round(n * 100);
  })();
  const effectiveCents = customDollars.trim() ? customCents : selectedCents;

  async function send() {
    setError(null);
    if (effectiveCents == null) {
      setError("Enter a tip amount.");
      return;
    }
    const v = validateTipAmountCents(effectiveCents);
    if (!v.ok) {
      setError(
        v.error === "below_minimum"
          ? `The minimum tip is ${dollars(MIN_TIP_CENTS)}.`
          : v.error === "above_maximum"
            ? `The maximum tip is ${dollars(MAX_TIP_CENTS)}.`
            : "Enter a valid dollar amount.",
      );
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(`/api/creators/${creatorId}/tip`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          amount_cents: v.cents,
          message: message.trim() || undefined,
          return_path: pathname,
        }),
      });
      if (res.status === 401) {
        router.push(
          `/login?redirect_to=${encodeURIComponent(pathname || "/")}`,
        );
        return;
      }
      const json = (await res.json().catch(() => ({}))) as {
        checkout_url?: string;
        error?: string;
      };
      if (!res.ok || !json.checkout_url) {
        setError(
          json.error === "cannot_tip_self"
            ? "You can't tip your own profile."
            : "Couldn't start the tip. Try again.",
        );
        return;
      }
      window.location.href = json.checkout_url;
    } catch {
      setError("Couldn't start the tip. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      {justTipped && (
        <p className="mt-2 text-body-sm text-moonbeem-pink">
          Thanks for supporting {creatorName}.
        </p>
      )}
      <button
        type="button"
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
        className="rounded-md border border-moonbeem-pink px-4 py-1.5 text-body-sm font-semibold text-moonbeem-pink transition-opacity hover:opacity-80"
      >
        Tip
      </button>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Send a tip to ${creatorName}`}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div className="w-full max-w-md rounded-2xl border border-white/10 bg-moonbeem-black p-6 shadow-2xl">
            <h2 className="m-0 font-wordmark text-heading-md text-moonbeem-pink">
              Send a tip to {creatorName}
            </h2>
            <p className="mt-2 text-body-sm text-moonbeem-ink-muted">
              Creators keep 100% of every tip.
            </p>

            <div className="mt-4 flex flex-wrap gap-2">
              {TIP_PRESET_CENTS.map((c) => {
                const active = !customDollars.trim() && selectedCents === c;
                return (
                  <button
                    key={c}
                    type="button"
                    onClick={() => {
                      setSelectedCents(c);
                      setCustomDollars("");
                    }}
                    className={`rounded-md border px-4 py-2 text-body-sm transition-colors ${
                      active
                        ? "border-moonbeem-pink bg-moonbeem-pink/10 text-moonbeem-pink"
                        : "border-white/10 text-moonbeem-ink hover:border-moonbeem-pink"
                    }`}
                  >
                    {dollars(c)}
                  </button>
                );
              })}
            </div>

            <label className="mt-4 block text-caption text-moonbeem-ink-muted">
              Custom amount (up to {dollars(MAX_TIP_CENTS)})
              <div className="mt-1 flex items-center gap-2">
                <span className="text-body-sm text-moonbeem-ink-muted">$</span>
                <input
                  inputMode="decimal"
                  placeholder="0.00"
                  value={customDollars}
                  onChange={(e) => {
                    setCustomDollars(e.target.value);
                    setSelectedCents(null);
                  }}
                  className="w-full rounded-md border border-white/10 bg-transparent px-3 py-2 text-body-sm text-moonbeem-ink outline-none focus:border-moonbeem-pink"
                />
              </div>
            </label>

            <label className="mt-4 block text-caption text-moonbeem-ink-muted">
              Message (optional)
              <textarea
                maxLength={280}
                rows={2}
                placeholder="Say something nice"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                className="mt-1 w-full resize-none rounded-md border border-white/10 bg-transparent px-3 py-2 text-body-sm text-moonbeem-ink outline-none focus:border-moonbeem-pink"
              />
            </label>

            {error && (
              <p className="mt-3 text-caption text-moonbeem-magenta">{error}</p>
            )}

            <div className="mt-6 flex flex-wrap items-center justify-end gap-3">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-md border border-white/10 px-4 py-2 text-body-sm text-moonbeem-ink-muted transition-colors hover:border-moonbeem-pink hover:text-moonbeem-pink"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={send}
                disabled={submitting}
                className="rounded-md bg-moonbeem-pink px-5 py-2 text-body-sm font-semibold text-moonbeem-navy transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {submitting
                  ? "Starting…"
                  : effectiveCents && validateTipAmountCents(effectiveCents).ok
                    ? `Tip ${dollars(effectiveCents)}`
                    : "Tip"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
