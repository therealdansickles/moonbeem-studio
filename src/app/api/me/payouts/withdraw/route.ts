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
//   2. Reject if a withdrawal is already in flight ('pending') OR parked
//      in 'needs_reconciliation' (a prior stamp failure — see step 7a).
//   3. Compute the available balance from unwithdrawn earnings.
//   4. Reject if balance < MIN_WITHDRAWAL_CENTS.
//   5. Insert a withdrawal row in 'pending'.
//   6. Call stripe.transfers.create with the withdrawal id as
//      idempotency key — guards against double-clicks.
//   7. On Stripe success + earnings-stamp success: mark withdrawal
//      'completed' with the transfer id. (This is the ONLY path to
//      'completed'.)
//   7a. On Stripe success but earnings-stamp FAILURE: money moved but the
//      earnings are still withdrawn_at NULL — park the withdrawal in
//      'needs_reconciliation' (NOT 'completed'), record the transfer id,
//      leave completed_at null, and return a non-success response. The
//      step-2 guard then blocks this creator's future withdrawals until an
//      admin reconciles by hand (docs/payout-reconciliation.md). This is
//      FIX A, closing the double-pay window; FIX B (a structural
//      creator_earnings.withdrawal_id link + auto reconciler) is the
//      durable follow-up.
//   8. On Stripe failure (transfer throw): mark withdrawal 'failed';
//      earnings stay unwithdrawn so the user can retry (no money moved).

import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { verifySession } from "@/lib/dal";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { getStripe } from "@/lib/stripe/server";
import { enforce } from "@/lib/ratelimit";

const MIN_WITHDRAWAL_CENTS = 1000;

export async function POST() {
  const session = await verifySession();
  const limit = await enforce("userWrites", session.userId, "me/payouts/withdraw");
  if (!limit.ok) return limit.response;
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

  // Reject if a withdrawal is already in flight ('pending') OR if a prior
  // withdrawal is parked in 'needs_reconciliation'. The latter means a
  // transfer SUCCEEDED but the earnings stamp failed, so those earnings are
  // still withdrawn_at NULL — letting a new withdrawal through would re-sum
  // and re-pay them (double-pay). Blocking on both statuses is FIX A: the
  // creator stays blocked until an admin clears the stuck row by hand
  // (docs/payout-reconciliation.md). Race window: two simultaneous POSTs
  // could both pass this check; the idempotency key on the Stripe call
  // backstops a double-transfer. For v1 the UI disables the button too.
  const { data: blocking } = await supabase
    .from("withdrawals")
    .select("id, status")
    .eq("creator_id", creator.id)
    .in("status", ["pending", "needs_reconciliation"])
    .limit(1);
  if ((blocking ?? []).length > 0) {
    const blockedStatus = (blocking![0].status as string) ?? "pending";
    return NextResponse.json(
      {
        error:
          blockedStatus === "needs_reconciliation"
            ? "withdrawal_needs_reconciliation"
            : "pending_withdrawal_in_flight",
      },
      { status: 409 },
    );
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

  // Stripe succeeded — the money has moved to the connected account. Stamp
  // withdrawn_at on the earnings rows we settled (clamp to the snapshotted
  // ids — a row that landed between snapshot and now stays unwithdrawn for
  // the next call). This is a single UPDATE … WHERE id IN (…): all-or-nothing
  // for the batch.
  const withdrawnAt = new Date().toISOString();
  const { error: stampErr } = await supabase
    .from("creator_earnings")
    .update({ withdrawn_at: withdrawnAt })
    .in("id", earningsIdsToSettle);

  if (stampErr) {
    // DOUBLE-PAY GUARD (FIX A). The transfer SUCCEEDED but we could not stamp
    // withdrawn_at, so these earnings are still withdrawn_at NULL. We must NOT
    // mark this 'completed' and must NOT report clean success — either would
    // let the creator withdraw again and re-pay the same earnings. Park the
    // row in 'needs_reconciliation' (money moved → record the transfer id;
    // completed_at stays null because it is NOT complete). The step-2 re-entry
    // guard blocks this creator's future withdrawals until an admin reconciles
    // the row by hand. Manual-clear steps: docs/payout-reconciliation.md.
    // (FIX B — a structural creator_earnings.withdrawal_id link + an auto
    // reconciler — is the durable follow-up, not this change.)
    console.error(
      `[payouts] RECONCILE-REQUIRED withdrawal=${withdrawalId} transfer=${transfer.id} ` +
        `stamp failed AFTER successful transfer (money moved, earnings NOT stamped): ${stampErr.message}; ` +
        `unstamped earnings_ids=[${earningsIdsToSettle.join(",")}]`,
    );
    await supabase
      .from("withdrawals")
      .update({
        status: "needs_reconciliation",
        stripe_transfer_id: transfer.id,
        completed_at: null,
      })
      .eq("id", withdrawalId);
    return NextResponse.json(
      {
        ok: false,
        needs_reconciliation: true,
        withdrawal_id: withdrawalId,
        stripe_transfer_id: transfer.id,
        amount_cents: totalCents,
        detail:
          "Your payout was sent but our records need a manual check. " +
          "It will be reconciled shortly — no further action is needed.",
      },
      { status: 202 },
    );
  }

  // Stamp succeeded — this is the ONLY path to 'completed'.
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
