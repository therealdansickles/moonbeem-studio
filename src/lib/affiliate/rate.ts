// Shared affiliate-rate validation — the SINGLE source of the exact-basis-points
// rule, used by BOTH the server (PATCH /api/titles/[id]/transact, AUTHORITATIVE)
// and the client (AffiliatePricingCard, a UX mirror).
//
// The rate is stored on titles.creator_share_pct as a FRACTION (0.10 = 10%). The
// settle pass converts it to basis points (bps = fraction * 10000) and computes
// floor(distributor_gross * bps / 10000). A fraction that does NOT map to an
// EXACT integer bps makes the settle pass REFUSE the row — a silent settlement
// failure (the rental never settles, no payout, no error surfaced). So a
// non-exact rate must NEVER be persisted; this validator is the guard.
//
// (The exact-bps rule is byte-identical to the settle pass's toExactBps; that
// copy is left in place to avoid editing the live money-rail route — unifying the
// two behind this helper is a clean, deferred follow-up.)

// Sanity cap on the affiliate share a distributor may set. 50% is generous — the
// cut comes from the distributor's OWN net, so this is a guardrail, not policy.
export const MAX_AFFILIATE_SHARE_FRACTION = 0.5;

// A fraction (0.10) -> exact integer basis points (1000), or null if it does not
// map to an exact, non-negative bps. Identical rule to the settle pass.
export function fractionToExactBps(fraction: number): number | null {
  if (!Number.isFinite(fraction)) return null;
  const scaled = fraction * 10000;
  const bps = Math.round(scaled);
  if (Math.abs(scaled - bps) > 1e-6) return null; // non-exact bps
  if (bps < 0) return null;
  return bps;
}

// Server-AUTHORITATIVE validity for a creator_share_pct value off the wire:
//   null          -> accepted, "no affiliate program" (store NULL)
//   number in     -> accepted iff within [0, MAX] AND maps to exact bps
//     [0, MAX]       (returns the fraction to store)
//   anything else -> rejected (caller returns invalid_affiliate_rate, no write)
export function validateCreatorSharePct(
  value: unknown,
): { ok: true; value: number | null } | { ok: false } {
  if (value === null) return { ok: true, value: null };
  if (typeof value !== "number" || !Number.isFinite(value)) return { ok: false };
  if (value < 0 || value > MAX_AFFILIATE_SHARE_FRACTION) return { ok: false };
  if (fractionToExactBps(value) === null) return { ok: false };
  return { ok: true, value };
}

// Parse a PERCENTAGE string ("10", "10.5", "12.25") -> a FRACTION (0.10), or null
// if invalid. Mirrors parseDollarsToCents: AT MOST 2 decimal places (so the
// fraction has <=4 decimals -> *10000 is an integer -> exact bps), non-negative,
// within the cap. Float-safe: the fraction is built from integer parts (the
// percent's hundredths ARE the basis points).
export function parsePercentToFraction(input: string): number | null {
  const m = input
    .trim()
    .replace(/%$/, "")
    .trim()
    .match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!m) return null;
  const whole = parseInt(m[1], 10);
  const decimals = (m[2] ?? "").padEnd(2, "0"); // "5" -> "50", "" -> "00"
  const bps = whole * 100 + parseInt(decimals, 10); // 10.55% -> 1055 bps exactly
  if (!Number.isSafeInteger(bps)) return null;
  const fraction = bps / 10000;
  if (fraction < 0 || fraction > MAX_AFFILIATE_SHARE_FRACTION) return null;
  return fraction;
}
