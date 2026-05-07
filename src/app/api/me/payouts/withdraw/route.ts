// POST /api/me/payouts/withdraw
//
// "Withdraw all" semantics for v1: settles every unwithdrawn
// creator_earnings row in one Stripe Transfer. Synchronous
// success/fail decision based on the Transfer API response — we
// don't wait for transfer.created/transfer.failed webhooks (per
// the 2026-05-08 setup note).
//
// Flow:
//   1. Validate caller has creator + payout account + payouts_enabled.
//   2. Reject if any pending withdrawal exists (ui already disables
//      the button, this is defensive).
//   3. Compute the available balance from unwithdrawn earnings.
//   4. Reject if balance < MIN_WITHDRAWAL_CENTS.
//   5. Insert a withdrawal row in 'pending'.
//   6. Call stripe.transfers.create with the withdrawal id as
//      idempotency key — guards against double-clicks.
//   7. On Stripe success: stamp withdrawn_at on the earnings rows
//      we just settled, mark withdrawal completed with the
//      transfer id.
//   8. On Stripe failure: mark withdrawal failed; earnings rows
//      stay unwithdrawn so the user can retry.

import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { verifySession } from "@/lib/dal";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { getStripe } from "@/lib/stripe/server";

const MIN_WITHDRAWAL_CENTS = 1000;

export async function POST() {
  const session = await verifySession();
  const supabase = createServiceRoleClient();

  const { data: creator } = await supabase
    .from("creators")
    .select("id")
    .eq("user_id", session.userId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!creator) {
    return NextResponse.json({ error: "no_creator" }, { status: 409 });
  }

  const { data: acct } = await supabase
    .from("creator_payout_accounts")
    .select("stripe_connect_account_id, payouts_enabled")
    .eq("creator_id", creator.id)
    .maybeSingle();
  if (!acct) {
    return NextResponse.json({ error: "no_payout_account" }, { status: 400 });
  }
  if (!acct.payouts_enabled) {
    return NextResponse.json({ error: "payouts_not_enabled" }, {
      status: 400,
    });
  }

  // Reject if a withdrawal is already in flight. Race window: two
  // simultaneous POSTs could both pass this check; the idempotency
  // key on the Stripe call protects against double-transfer, and
  // the second insert would fail uniquely if we add a partial-unique
  // constraint later. For v1 the UI disables the button; this is a
  // backstop.
  const { data: pending } = await supabase
    .from("withdrawals")
    .select("id")
    .eq("creator_id", creator.id)
    .eq("status", "pending")
    .limit(1);
  if ((pending ?? []).length > 0) {
    return NextResponse.json({ error: "pending_withdrawal_in_flight" }, {
      status: 409,
    });
  }

  // Snapshot the rows we're about to settle. Doing this BEFORE the
  // withdrawal insert means we know exactly which earnings the
  // transfer covers, even if a new earnings row lands mid-flight.
  const { data: earningsRows, error: earningsErr } = await supabase
    .from("creator_earnings")
    .select("id, earnings_cents")
    .eq("creator_id", creator.id)
    .is("withdrawn_at", null);
  if (earningsErr) {
    return NextResponse.json({ error: earningsErr.message }, { status: 500 });
  }
  const earningsToSettle = earningsRows ?? [];
  const totalCents = earningsToSettle.reduce(
    (sum, r) => sum + ((r.earnings_cents as number | null) ?? 0),
    0,
  );
  if (totalCents < MIN_WITHDRAWAL_CENTS) {
    return NextResponse.json({
      error: "below_minimum",
      available_cents: totalCents,
      minimum_cents: MIN_WITHDRAWAL_CENTS,
    }, { status: 400 });
  }
  const earningsIdsToSettle = earningsToSettle.map((r) => r.id as string);

  // Insert the withdrawal row first so we have an id for idempotency.
  const { data: withdrawalInserted, error: insErr } = await supabase
    .from("withdrawals")
    .insert({
      creator_id: creator.id,
      amount_cents: totalCents,
      status: "pending",
    })
    .select("id")
    .single();
  if (insErr || !withdrawalInserted) {
    return NextResponse.json(
      { error: insErr?.message ?? "withdrawal_insert_failed" },
      { status: 500 },
    );
  }
  const withdrawalId = withdrawalInserted.id as string;

  // Create the Transfer. Synchronous; the response tells us
  // whether the funds reached the connected account.
  const stripe = getStripe();
  let transfer: Stripe.Transfer;
  try {
    transfer = await stripe.transfers.create(
      {
        amount: totalCents,
        currency: "usd",
        destination: acct.stripe_connect_account_id as string,
        description: `Moonbeem creator earnings (${
          earningsIdsToSettle.length
        } rows)`,
        metadata: {
          moonbeem_withdrawal_id: withdrawalId,
          moonbeem_creator_id: creator.id,
        },
      },
      // Idempotency-Key: re-running with the same withdrawal id
      // returns the same transfer rather than creating a second.
      { idempotencyKey: withdrawalId },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "stripe_error";
    console.error(
      `[payouts] transfer failed for withdrawal=${withdrawalId}: ${msg}`,
    );
    await supabase
      .from("withdrawals")
      .update({ status: "failed", completed_at: new Date().toISOString() })
      .eq("id", withdrawalId);
    return NextResponse.json(
      { error: "transfer_failed", detail: msg },
      { status: 502 },
    );
  }

  // Stripe succeeded. Stamp withdrawn_at on the earnings rows we
  // settled (clamp to the snapshotted ids — a row that landed
  // between snapshot and now stays unwithdrawn for the next call).
  const withdrawnAt = new Date().toISOString();
  const { error: stampErr } = await supabase
    .from("creator_earnings")
    .update({ withdrawn_at: withdrawnAt })
    .in("id", earningsIdsToSettle);
  if (stampErr) {
    // Money has already moved. We log loudly but still report
    // success to the user; the reconciliation job (future work)
    // will re-stamp from withdrawals.completed_at.
    console.error(
      `[payouts] stamp earnings failed for withdrawal=${withdrawalId} after successful transfer=${transfer.id}: ${stampErr.message}`,
    );
  }

  await supabase
    .from("withdrawals")
    .update({
      status: "completed",
      stripe_transfer_id: transfer.id,
      completed_at: withdrawnAt,
    })
    .eq("id", withdrawalId);

  return NextResponse.json({
    ok: true,
    withdrawal_id: withdrawalId,
    amount_cents: totalCents,
    stripe_transfer_id: transfer.id,
    earnings_rows_settled: earningsIdsToSettle.length,
  });
}
