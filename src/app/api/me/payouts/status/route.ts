// GET /api/me/payouts/status
//
// Snapshot of the caller's payout state for the /me UI.
// Returns:
//   has_account: boolean — creator_payout_accounts row exists
//   onboarding_completed: boolean
//   payouts_enabled: boolean — Stripe-verified, can receive transfers
//   available_cents: int — sum of unwithdrawn creator_earnings
//                          minus any pending withdrawal amount
//   pending_cents: int — sum of in-flight withdrawals
//   minimum_cents: int — withdrawal floor (1000 = $10)

import { NextResponse } from "next/server";
import { verifySession } from "@/lib/dal";
import { createServiceRoleClient } from "@/lib/supabase/service";

const MIN_WITHDRAWAL_CENTS = 1000;

export async function GET() {
  const session = await verifySession();
  const supabase = createServiceRoleClient();

  const { data: creator } = await supabase
    .from("creators")
    .select("id")
    .eq("user_id", session.userId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!creator) {
    return NextResponse.json({
      has_account: false,
      onboarding_completed: false,
      payouts_enabled: false,
      available_cents: 0,
      pending_cents: 0,
      minimum_cents: MIN_WITHDRAWAL_CENTS,
    });
  }

  const [acctRes, earningsRes, pendingRes] = await Promise.all([
    supabase
      .from("creator_payout_accounts")
      .select("onboarding_completed, payouts_enabled")
      .eq("creator_id", creator.id)
      .maybeSingle(),
    supabase
      .from("creator_earnings")
      .select("earnings_cents")
      .eq("creator_id", creator.id)
      .is("withdrawn_at", null),
    supabase
      .from("withdrawals")
      .select("amount_cents")
      .eq("creator_id", creator.id)
      .eq("status", "pending"),
  ]);

  const acct = acctRes.data;
  const unwithdrawnCents = (earningsRes.data ?? []).reduce(
    (sum, r) => sum + ((r.earnings_cents as number | null) ?? 0),
    0,
  );
  const pendingCents = (pendingRes.data ?? []).reduce(
    (sum, r) => sum + ((r.amount_cents as number | null) ?? 0),
    0,
  );
  const availableCents = Math.max(0, unwithdrawnCents - pendingCents);

  return NextResponse.json({
    has_account: !!acct,
    onboarding_completed: !!acct?.onboarding_completed,
    payouts_enabled: !!acct?.payouts_enabled,
    available_cents: availableCents,
    pending_cents: pendingCents,
    minimum_cents: MIN_WITHDRAWAL_CENTS,
  });
}
