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
//
// The value-scaled maturity rule lives in ./maturity (dependency-free + unit-
// testable); the balance AND the withdraw snapshot both use it, so they agree.

import { createServiceRoleClient } from "@/lib/supabase/service";
import {
  isAffiliateCutMature,
  selectMaturedAffiliateRows,
  type AvailableAffiliateSettlements,
} from "./maturity";

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
      // isAffiliateCutMature is the shared value-scaled rule (also used by the
      // withdraw snapshot) so the balance and the snapshot can never disagree.
      if (
        isAffiliateCutMature(cents, Date.parse(r.settled_at as string), nowMs)
      ) {
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

// The AVAILABLE (matured-held) affiliate settlements for a creator — the withdraw
// SNAPSHOT. Returns the row ids + cut_cents AND their sum from ONE fetch at ONE
// moment (via selectMaturedAffiliateRows), so total_cents === sum(rows): the
// withdraw transfers total_cents and flips exactly rows.map(id) to 'paid', so the
// amount can't drift from the rows it pays. Service-role (the ledger is
// RLS-on-no-policies); the caller resolves creatorId from the session.
export async function getAvailableAffiliateSettlements(
  creatorId: string,
): Promise<AvailableAffiliateSettlements> {
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from("transaction_settlements")
    .select("id, affiliate_cut_cents, settled_at")
    .eq("creator_id", creatorId)
    .eq("payout_status", "held")
    .gt("affiliate_cut_cents", 0);
  if (error || !data) return { rows: [], total_cents: 0 };
  return selectMaturedAffiliateRows(
    data as Array<{
      id: string;
      affiliate_cut_cents: number | null;
      settled_at: string;
    }>,
    Date.now(),
  );
}
