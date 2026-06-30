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

// 14-day maturity hold (mirrors the partner-rail window): a 'held' cut is
// PENDING until 14 days after settlement, then AVAILABLE. The window lets a
// refund/dispute (which flips 'held' -> 'refunded'/'disputed') land first.
const MATURITY_MS = 14 * 24 * 60 * 60 * 1000;

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
  //   'held'                    -> owed-and-unpaid (pending if <14d, else available)
  //   'paid'                    -> earned-but-already-cashed (lifetime only)
  //   refunded/disputed/reversed -> clawed back (excluded entirely)
  // Integer cents throughout.
  const matureCutoffMs = Date.now() - MATURITY_MS;
  let pending = 0;
  let available = 0;
  let lifetime = 0;
  for (const r of data) {
    const cents = (r.affiliate_cut_cents as number | null) ?? 0;
    const status = r.payout_status as string;
    if (status === "held") {
      const settledMs = Date.parse(r.settled_at as string);
      // Mature (>=14d old) -> available; otherwise (or unparseable) -> pending
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
