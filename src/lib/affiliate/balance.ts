// The creator-scoped AFFILIATE earnings balance, computed from the immutable
// settlement ledger (transaction_settlements).
//
// This is the SINGLE home of the three-bucket validity predicate — both the
// /api/me/affiliate/balance route and the /me server component call it — so the
// security boundary can never drift between them.
//
// It takes an ALREADY-RESOLVED creatorId (the caller resolves it from the
// session). It does NOT resolve the user itself: that keeps auth/resolution at
// the boundary and the function reusable. It MUST NEVER be called with a
// client-supplied creatorId — both callers resolve server-side first.

import { createServiceRoleClient } from "@/lib/supabase/service";

// VALUE-SCALED maturity hold: a 'held' cut is PENDING until its hold elapses,
// then AVAILABLE. The hold scales with the cut SIZE — large cuts are held LONGER
// so the bulk of the dispute window closes before they become withdrawable,
// shrinking the absorb/clawback exposure on the cuts where a paid-then-disputed
// loss would be biggest:
//   cut <  $5.00 (500c) -> 14-day hold (normal)
//   cut >= $5.00 (500c) -> 60-day hold (high-value)
// 60d is still < the ~120-day dispute tail, so it REDUCES (not eliminates)
// paid-then-disputed large cuts; the residual is captured by the 'reversed'
// clawback marking (Stage 3). The window also lets a refund/dispute flip 'held'
// -> 'refunded'/'disputed' before a cut is ever paid.
const HIGH_VALUE_CUT_CENTS = 500; // cuts >= $5.00 are "high value"
const HOLD_LOW_MS = 14 * 24 * 60 * 60 * 1000; // 14-day hold for normal cuts
const HOLD_HIGH_MS = 60 * 24 * 60 * 60 * 1000; // 60-day hold for high-value cuts

export type AffiliateBalance = {
  pending_cents: number;
  available_cents: number;
  lifetime_cents: number;
};

export async function getAffiliateBalance(
  creatorId: string,
): Promise<AffiliateBalance> {
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from("transaction_settlements")
    .select("affiliate_cut_cents, payout_status, settled_at")
    .eq("creator_id", creatorId)
    .gt("affiliate_cut_cents", 0);
  if (error || !data) {
    return { pending_cents: 0, available_cents: 0, lifetime_cents: 0 };
  }

  // VALIDITY PREDICATE — keyed on payout_status, NOT the *_at timestamps. A
  // BORN-blocked settlement (the settle pass ran AFTER a refund/dispute) carries
  // payout_status='refunded'/'disputed' but a NULL refunded_at/disputed_at (the
  // timestamp-stamp was the 0-row no-op of that race), so the timestamps are not
  // a reliable validity signal — payout_status is authoritative:
  //   'held'                    -> owed-and-unpaid (pending until its value-scaled hold elapses, then available)
  //   'paid'                    -> earned-but-already-cashed (lifetime only)
  //   refunded/disputed/reversed -> clawed back (excluded entirely)
  // Integer cents throughout.
  const nowMs = Date.now();
  let pending = 0;
  let available = 0;
  let lifetime = 0;
  for (const r of data) {
    const cents = (r.affiliate_cut_cents as number | null) ?? 0;
    const status = r.payout_status as string;
    if (status === "held") {
      // Per-row, value-scaled hold: high-value cuts mature later (see above).
      const holdMs =
        cents >= HIGH_VALUE_CUT_CENTS ? HOLD_HIGH_MS : HOLD_LOW_MS;
      const matureCutoffMs = nowMs - holdMs;
      const settledMs = Date.parse(r.settled_at as string);
      // Matured -> available; otherwise (or an unparseable date) -> pending
      // (conservative: an unreadable date stays unwithdrawable).
      if (Number.isFinite(settledMs) && settledMs <= matureCutoffMs) {
        available += cents;
      } else {
        pending += cents;
      }
    }
    if (status === "held" || status === "paid") {
      lifetime += cents;
    }
  }
  return {
    pending_cents: pending,
    available_cents: available,
    lifetime_cents: lifetime,
  };
}
