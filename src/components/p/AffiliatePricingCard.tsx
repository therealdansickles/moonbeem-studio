"use client";

// Partner-admin AFFILIATE rate card (Stage C). Declares whether this film rewards
// curators who drive its rentals/purchases, and at what rate ->
// PATCH /api/titles/[id]/transact { creator_share_pct }. The rate is a FRACTION
// stored on titles.creator_share_pct; the cut comes out of the DISTRIBUTOR's net
// (Moonbeem's take is untouched). Optional — the distributor's choice. Client
// island, rendered by TitleUploadPanel right after the Purchase card, styled like
// the pricing cards.
//
// THE rate must map to exact basis points or the settle pass silently refuses
// the rental, so the % input is validated with the SHARED parsePercentToFraction
// (<=2 decimals, <= cap). This is a UX MIRROR; the server (/transact) re-validates
// with the same shared validator and is authoritative.

import { useState } from "react";
import {
  parsePercentToFraction,
  MAX_AFFILIATE_SHARE_FRACTION,
} from "@/lib/affiliate/rate";

const MAX_PCT = MAX_AFFILIATE_SHARE_FRACTION * 100; // 50

function friendlyError(code: string | undefined, status: number): string {
  switch (code) {
    case "invalid_affiliate_rate":
      return `Enter a whole or 2-decimal percentage above 0 and up to ${MAX_PCT}% (e.g. 10 or 12.5).`;
    case "not_authorized":
      return "You don't have permission to set this here.";
    case "not_authenticated":
      return "Please sign in again.";
    default:
      return code ?? `Couldn't save the affiliate rate (${status}).`;
  }
}

const toBps = (f: number | null) => (f == null ? null : Math.round(f * 10000));

export default function AffiliatePricingCard({
  titleId,
  initialEnabled,
  initialPct,
}: {
  titleId: string;
  initialEnabled: boolean;
  initialPct: number | null;
}) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [pctInput, setPctInput] = useState(
    initialPct != null ? String(initialPct) : "",
  );
  const [phase, setPhase] = useState<"idle" | "saving" | "saved">("idle");
  const [error, setError] = useState<string | null>(null);
  const [savedEnabled, setSavedEnabled] = useState(initialEnabled);
  const [savedFraction, setSavedFraction] = useState<number | null>(
    initialEnabled && initialPct != null ? initialPct / 100 : null,
  );

  const fraction = parsePercentToFraction(pctInput); // number | null (fraction)
  const pctValid = fraction != null && fraction > 0;
  // What we'd persist: a fraction when enabled+valid, null when disabled.
  const sendValue = enabled ? fraction : null;

  // Dirty in BPS (integers) so float fractions can't cause spurious diffs.
  const dirty =
    enabled !== savedEnabled || toBps(sendValue) !== toBps(savedFraction);
  const canSave = dirty && phase !== "saving" && (!enabled || pctValid);

  function clearFeedback() {
    setError(null);
    if (phase === "saved") setPhase("idle");
  }

  async function save() {
    if (!canSave) return;
    setPhase("saving");
    setError(null);
    try {
      const res = await fetch(`/api/titles/${titleId}/transact`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        // Unchecked -> null (no affiliate program). Checked -> the validated
        // fraction. The server re-validates exact-bps and is authoritative.
        body: JSON.stringify({ creator_share_pct: sendValue }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(friendlyError(json.error, res.status));
        setPhase("idle");
        return;
      }
      setSavedEnabled(enabled);
      setSavedFraction(sendValue);
      setPhase("saved");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("idle");
    }
  }

  const savedPct =
    savedEnabled && savedFraction != null
      ? (toBps(savedFraction) ?? 0) / 100
      : 0;
  const summary =
    savedPct > 0
      ? `Curators earn ${savedPct}% of your share on rentals they drive`
      : "No affiliate rewards on this film";

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
      <div className="flex items-center gap-3">
        <span className="rounded-full bg-moonbeem-violet/20 px-2.5 py-0.5 text-caption font-medium text-moonbeem-violet-soft">
          Affiliate
        </span>
        <span className="text-caption text-moonbeem-ink-subtle">
          Reward curators who drive rentals of this film
        </span>
      </div>

      {/* Enable toggle */}
      <label className="mt-4 flex cursor-pointer items-center gap-3">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => {
            clearFeedback();
            setEnabled(e.target.checked);
          }}
          className="accent-moonbeem-pink"
        />
        <span className="text-body-sm text-moonbeem-ink">
          Offer affiliate rewards on this film
        </span>
      </label>

      {/* Percentage input (% -> fraction; <=2 decimals = exact bps) */}
      <div className={`mt-4 ${enabled ? "" : "opacity-50"}`}>
        <div className="flex items-center gap-2">
          <input
            type="text"
            inputMode="decimal"
            value={pctInput}
            onChange={(e) => {
              clearFeedback();
              setPctInput(e.target.value);
            }}
            disabled={!enabled}
            placeholder="10"
            className="w-20 rounded-md border border-white/10 bg-black/30 px-3 py-2 text-body-sm text-moonbeem-ink focus:border-moonbeem-pink focus:outline-none disabled:cursor-not-allowed"
          />
          <span className="text-body-sm text-moonbeem-ink-subtle">
            % of your distributor share
          </span>
        </div>
        {enabled && pctInput.trim() !== "" && !pctValid && (
          <p className="mt-2 text-caption text-moonbeem-magenta m-0">
            Enter a whole or 2-decimal percentage above 0 and up to {MAX_PCT}%
            (e.g. 10 or 12.5).
          </p>
        )}
        <p className="mt-2 text-caption text-moonbeem-ink-subtle m-0">
          The reward comes out of your distributor share — Moonbeem&rsquo;s fee is
          unchanged.
        </p>
      </div>

      {/* Live summary */}
      <p
        className={`mt-4 text-body-sm m-0 ${
          savedPct > 0 ? "text-moonbeem-lime" : "text-moonbeem-ink-subtle"
        }`}
      >
        {summary}
      </p>

      {error && (
        <p className="mt-3 text-caption text-moonbeem-magenta m-0">{error}</p>
      )}

      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={!canSave}
          className="rounded-md bg-moonbeem-pink px-4 py-2 text-caption font-semibold text-moonbeem-navy hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-30"
        >
          {phase === "saving" ? "Saving…" : "Save affiliate rate"}
        </button>
        {phase === "saved" && !dirty && (
          <span className="text-caption text-moonbeem-lime">Saved</span>
        )}
      </div>
    </div>
  );
}
