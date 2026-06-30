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
import { chunkedInOrThrow } from "@/lib/queries/chunked-in";

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
    .eq("source", "campaign")
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
      source: "campaign",
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
  // withdrawn_at on the snapshotted earnings, CHUNKED <=100 with LOUD-FAIL
  // (chunkedInOrThrow). Rationale: an unbounded `id=in.(...)` UPDATE URL can
  // overflow the gateway, and a degrade-to-empty chunk helper would SWALLOW a
  // failed chunk -> fall through to 'completed' -> the unstamped rows stay
  // withdrawn_at NULL and get RE-PAID on the next withdrawal (double-pay).
  // chunkedInOrThrow THROWS on any chunk error; on that throw — and on a
  // partial-settle count mismatch (the confirmation re-read below) — we PARK
  // in 'needs_reconciliation' (the EXISTING FIX-A branch), never 'completed',
  // never an uncaught crash. Each chunk's .select("id") yields the exact
  // stamped count. Earlier chunks that committed stay stamped; the whole
  // snapshot set is owned by the parked withdrawal for manual reconciliation,
  // and the step-2 re-entry guard blocks this creator until then.
  // (FIX B — a structural creator_earnings.withdrawal_id link + an auto
  // reconciler — is the durable follow-up, not this change.)
  const withdrawnAt = new Date().toISOString();

  // PARK: the only non-'completed' terminal for a transfer that already moved
  // money. Mirrors the prior FIX-A branch exactly (status ->
  // needs_reconciliation, record transfer id, completed_at stays null, 202).
  const parkForReconciliation = async (reason: string) => {
    console.error(
      `[payouts] RECONCILE-REQUIRED withdrawal=${withdrawalId} transfer=${transfer.id} ` +
        `${reason} (money moved AFTER successful transfer): ` +
        `earnings_ids=[${earningsIdsToSettle.join(",")}]`,
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
  };

  let stampedIds: string[];
  try {
    const stamped = await chunkedInOrThrow<{ id: string }>(
      earningsIdsToSettle,
      "withdraw.settle",
      (chunk) =>
        supabase
          .from("creator_earnings")
          .update({ withdrawn_at: withdrawnAt })
          .in("id", chunk)
          .select("id"),
    );
    stampedIds = stamped.map((r) => r.id);
  } catch (stampErr) {
    // A chunk errored AFTER the transfer. Prior chunks may have stamped; PARK
    // (never 'completed') — this closes the recon's double-pay window.
    return parkForReconciliation(
      `settle chunk failed: ${
        stampErr instanceof Error ? stampErr.message : "stamp_error"
      }`,
    );
  }

  // Confirmation re-read (recon flag 4): the settle must stamp EXACTLY the
  // snapshotted set. Fewer stamped (a partial settle with no hard error) must
  // NOT be marked completed — the unstamped rows would be re-paid next time.
  if (stampedIds.length !== earningsIdsToSettle.length) {
    return parkForReconciliation(
      `partial settle: stamped ${stampedIds.length} of ${earningsIdsToSettle.length}`,
    );
  }

  // Stamp confirmed complete — this is the ONLY path to 'completed'.
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
    earnings_rows_settled: stampedIds.length,
  });
}
