// Tip amount rules (money-integer cents). Server-authoritative — the client
// mirrors these for the preset chips + custom field, but the route is the source
// of truth. Zero platform fee is deliberate positioning: the creator receives
// 100% of the gross tip and Moonbeem absorbs the Stripe processing fee.

export const MIN_TIP_CENTS = 200; // $2 floor
export const MAX_TIP_CENTS = 50000; // $500 ceiling
export const TIP_PRESET_CENTS = [200, 500, 1000, 2000] as const; // $2 / $5 / $10 / $20 chips

export type TipAmountValidation =
  | { ok: true; cents: number }
  | { ok: false; error: "not_integer" | "below_minimum" | "above_maximum" };

// Validate a user-supplied tip amount in CENTS. Rejects non-integers/unsafe
// numbers, then the floor, then the ceiling (distinct errors so the UI can speak
// precisely).
export function validateTipAmountCents(raw: unknown): TipAmountValidation {
  if (
    typeof raw !== "number" ||
    !Number.isInteger(raw) ||
    !Number.isSafeInteger(raw)
  ) {
    return { ok: false, error: "not_integer" };
  }
  if (raw < MIN_TIP_CENTS) return { ok: false, error: "below_minimum" };
  if (raw > MAX_TIP_CENTS) return { ok: false, error: "above_maximum" };
  return { ok: true, cents: raw };
}
