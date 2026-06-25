"use client";

// Partner-admin rental pricing card (transactions sub-unit 1 — offer model).
// Declares whether a film is available to RENT and at what price -> PATCH
// /api/titles/[id]/transact. Distributor-set, INTEGER CENTS (the input takes
// dollars, parses to cents; no float is ever stored). No hard floor: if an
// external iTunes/Amazon price is known it's shown as guidance only, never
// enforced. Pre-money — this is the OFFER only, no charge / entitlement /
// playback gate yet. Client island, rendered by TitleUploadPanel, styled like
// the Territories card.

import { useState } from "react";

// Parse a dollars string ("$4.99", "4.99", "4") to integer CENTS without ever
// doing float math (4.99 * 100 = 498.9999… in JS). null if not a non-negative
// amount with at most 2 decimals.
function parseDollarsToCents(s: string): number | null {
  const m = s
    .trim()
    .replace(/^\$/, "")
    .trim()
    .match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!m) return null;
  const dollars = parseInt(m[1], 10);
  const centsPart = (m[2] ?? "").padEnd(2, "0"); // "9" -> "90", "" -> "00"
  const cents = dollars * 100 + parseInt(centsPart, 10);
  return Number.isSafeInteger(cents) ? cents : null;
}

// Display-only (float is fine here — it never gets stored).
function centsToDollars(c: number): string {
  return (c / 100).toFixed(2);
}

function friendlyError(code: string | undefined, status: number): string {
  switch (code) {
    case "invalid_price":
      return "Enter a valid price (dollars and cents).";
    case "price_required_when_enabled":
      return "Set a price above $0 to make the film rentable.";
    case "not_authorized":
      return "You don't have permission to set pricing here.";
    case "not_authenticated":
      return "Please sign in again.";
    default:
      return code ?? `Couldn't save pricing (${status}).`;
  }
}

export default function RentalPricingCard({
  titleId,
  initialEnabled,
  initialPriceCents,
  hasMuxEpisode,
  externalPriceUsd,
}: {
  titleId: string;
  initialEnabled: boolean;
  initialPriceCents: number | null;
  hasMuxEpisode: boolean;
  externalPriceUsd: number | null;
}) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [priceInput, setPriceInput] = useState(
    initialPriceCents != null && initialPriceCents > 0
      ? centsToDollars(initialPriceCents)
      : "",
  );
  const [phase, setPhase] = useState<"idle" | "saving" | "saved">("idle");
  const [error, setError] = useState<string | null>(null);
  const [savedEnabled, setSavedEnabled] = useState(initialEnabled);
  const [savedPriceCents, setSavedPriceCents] = useState(
    initialPriceCents ?? 0,
  );

  const priceCents = parseDollarsToCents(priceInput); // number | null
  const priceValid = priceCents != null && priceCents > 0;
  // Cents we'd persist: keep the typed value if parseable, else 0 (disabling
  // with an empty box clears the price). Enabling requires a valid price.
  const sendPriceCents = priceCents ?? 0;

  const currentSig = `${enabled}|${priceCents ?? "x"}`;
  const savedSig = `${savedEnabled}|${savedPriceCents}`;
  const dirty = currentSig !== savedSig;
  const canSave = dirty && phase !== "saving" && (!enabled || priceValid);

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
        body: JSON.stringify({
          transact_enabled: enabled,
          transact_price_cents: sendPriceCents,
        }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(friendlyError(json.error, res.status));
        setPhase("idle");
        return;
      }
      setSavedEnabled(enabled);
      setSavedPriceCents(sendPriceCents);
      // Reflect the canonical stored cents back into the box.
      if (sendPriceCents > 0) setPriceInput(centsToDollars(sendPriceCents));
      setPhase("saved");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("idle");
    }
  }

  const summary =
    savedEnabled && savedPriceCents > 0
      ? `Available to rent for $${centsToDollars(savedPriceCents)}`
      : "Not available to rent";

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
      <div className="flex items-center gap-3">
        <span className="rounded-full bg-moonbeem-violet/20 px-2.5 py-0.5 text-caption font-medium text-moonbeem-violet-soft">
          Rental
        </span>
        <span className="text-caption text-moonbeem-ink-subtle">
          What it costs to rent this film
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
          Make this film available to rent
        </span>
      </label>

      {/* Price input (dollars -> integer cents) */}
      <div className={`mt-4 ${enabled ? "" : "opacity-50"}`}>
        <div className="flex items-center gap-2">
          <span className="text-body-sm text-moonbeem-ink-subtle">$</span>
          <input
            type="text"
            inputMode="decimal"
            value={priceInput}
            onChange={(e) => {
              clearFeedback();
              setPriceInput(e.target.value);
            }}
            placeholder="4.99"
            className="w-28 rounded-md border border-white/10 bg-black/30 px-3 py-2 text-body-sm text-moonbeem-ink focus:border-moonbeem-pink focus:outline-none"
          />
          <span className="text-caption text-moonbeem-ink-subtle">USD</span>
        </div>
        {enabled && priceInput.trim() !== "" && !priceValid && (
          <p className="mt-2 text-caption text-moonbeem-magenta m-0">
            Enter a price above $0 (dollars and cents, e.g. 4.99).
          </p>
        )}
        {externalPriceUsd != null && (
          <p className="mt-2 text-caption text-moonbeem-ink-subtle m-0">
            Listed elsewhere at ${externalPriceUsd.toFixed(2)} — your price
            shouldn&rsquo;t undercut it.
          </p>
        )}
      </div>

      {/* No film yet: the offer can be set, but there's nothing to rent until a
          Mux film exists. */}
      {!hasMuxEpisode && (
        <p className="mt-3 text-caption text-moonbeem-ink-subtle m-0">
          You can set the price now, but this title has no film to rent yet —
          upload a film and it becomes rentable.
        </p>
      )}

      {/* Live summary */}
      <p
        className={`mt-4 text-body-sm m-0 ${
          savedEnabled && savedPriceCents > 0
            ? "text-moonbeem-lime"
            : "text-moonbeem-ink-subtle"
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
          {phase === "saving" ? "Saving…" : "Save pricing"}
        </button>
        {phase === "saved" && !dirty && (
          <span className="text-caption text-moonbeem-lime">Saved</span>
        )}
      </div>
    </div>
  );
}
