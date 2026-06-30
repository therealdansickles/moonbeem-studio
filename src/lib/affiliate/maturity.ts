// Affiliate cut MATURITY — the value-scaled hold rule + the withdraw-snapshot
// selection. DEPENDENCY-FREE (no DB/Stripe imports) so it is the SINGLE home of
// the maturity predicate AND directly unit-testable (npx tsx maturity.test.ts).
//
// VALUE-SCALED maturity hold: a 'held' cut is PENDING until its hold elapses,
// then AVAILABLE. The hold scales with the cut SIZE — large cuts are held LONGER
// so the bulk of the dispute window closes before they become withdrawable,
// shrinking the absorb/clawback exposure on the cuts where a paid-then-disputed
// loss would be biggest:
//   cut <  $5.00 (500c) -> 14-day hold (normal)
//   cut >= $5.00 (500c) -> 60-day hold (high-value)
// 60d is still < the ~120-day dispute tail, so it REDUCES (not eliminates)
// paid-then-disputed large cuts; the residual is captured by the 'reversed'
// clawback marking (Stage 3).

export const HIGH_VALUE_CUT_CENTS = 500; // cuts >= $5.00 are "high value"
export const HOLD_LOW_MS = 14 * 24 * 60 * 60 * 1000; // 14-day hold (normal cuts)
export const HOLD_HIGH_MS = 60 * 24 * 60 * 60 * 1000; // 60-day hold (high-value)

// A 'held' cut is MATURE (available) once its value-scaled hold has elapsed since
// settlement. An unparseable/NaN settled time -> false (conservative: stays
// unwithdrawable). Shared by the balance (getAffiliateBalance) AND the withdraw
// snapshot (selectMaturedAffiliateRows) so they can never disagree.
export function isAffiliateCutMature(
  cents: number,
  settledAtMs: number,
  nowMs: number,
): boolean {
  if (!Number.isFinite(settledAtMs)) return false;
  const holdMs = cents >= HIGH_VALUE_CUT_CENTS ? HOLD_HIGH_MS : HOLD_LOW_MS;
  return settledAtMs <= nowMs - holdMs;
}

export type AvailableAffiliateSettlements = {
  rows: { id: string; cut_cents: number }[];
  total_cents: number;
};

// Pure: from the fetched held+cut>0 settlement rows, select the MATURE ones and
// their sum. total_cents is summed from the SAME rows returned, in one pass, so
// total_cents === sum(rows.cut_cents) EXACTLY — the withdraw transfer amount will
// equal the sum of the rows it flips to 'paid' (no drift). Pure so the
// snapshot==sum property is directly testable without a DB.
export function selectMaturedAffiliateRows(
  fetched: Array<{
    id: string;
    affiliate_cut_cents: number | null;
    settled_at: string;
  }>,
  nowMs: number,
): AvailableAffiliateSettlements {
  const rows: { id: string; cut_cents: number }[] = [];
  let total = 0;
  for (const r of fetched) {
    const cents = r.affiliate_cut_cents ?? 0;
    if (cents <= 0) continue;
    if (isAffiliateCutMature(cents, Date.parse(r.settled_at), nowMs)) {
      rows.push({ id: r.id, cut_cents: cents });
      total += cents;
    }
  }
  return { rows, total_cents: total };
}
