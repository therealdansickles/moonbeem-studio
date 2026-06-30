// Clawback routing (Layer 3 Stage 3, policy C: ABSORB) — the PURE decision for
// where a settlement's payout_status goes when its rental is refunded/disputed.
// Dependency-free + tsx-testable. The webhook handlers implement this decision via
// two disjoint guarded UPDATEs (idempotent, no fetch); this function is the spec
// they must match and the test's source of truth.
//
// POLICY C (absorb): a cut that is ALREADY 'paid' (the curator was paid out) and
// whose rental is then refunded/disputed is marked 'reversed' — and the funds are
// ABSORBED. No Stripe reversal (no transfers.createReversal), no negative carry.
// The 'reversed' marking + transaction_settlements.withdrawal_id capture the
// exposure, so an Option D upgrade (actual recovery) is additive later. The
// 60-day value-scaled hold on large cuts already shrinks the paid-then-disputed
// case. KNOWN v1 EDGE: there is no charge.dispute.closed handler, so a 'paid' cut
// disputed->reversed then WON stays 'reversed' (understates lifetime — a record
// discrepancy, not a payout harm, since C never clawed money; correct manually).
//
//   refund/dispute on 'held'   -> 'refunded'/'disputed' (never paid; payout-blocked)
//   refund/dispute on 'paid'   -> 'reversed'            (was paid out; ABSORB)
//   refund also on 'disputed'  -> 'refunded'            (refund-wins; held-origin)
//   already-terminal           -> null                 (no-op; idempotent re-delivery)

export type PayoutStatus =
  | "held"
  | "paid"
  | "refunded"
  | "disputed"
  | "reversed";

export type ClawbackEvent = "refund" | "dispute";

// The target status, or null if the current status is a terminal that must NOT be
// re-flipped (idempotency on a re-delivered webhook).
export function clawbackTargetStatus(
  current: PayoutStatus,
  event: ClawbackEvent,
): "reversed" | "refunded" | "disputed" | null {
  // A paid cut, either way, is absorbed -> reversed.
  if (current === "paid") return "reversed";
  if (event === "refund") {
    // held + disputed -> refunded (refund-wins over a held-origin dispute);
    // refunded/reversed are terminal -> no-op.
    if (current === "held" || current === "disputed") return "refunded";
    return null;
  }
  // event === "dispute": only held -> disputed; refunded/reversed/disputed no-op.
  if (current === "held") return "disputed";
  return null;
}
