// POST /api/me/affiliate/withdraw
//
// Pays a curator their AVAILABLE affiliate balance — the matured 'held'
// transaction_settlements affiliate cuts — in one Stripe Transfer. A faithful
// MIRROR of the proven campaign rail (POST /api/me/payouts/withdraw): same
// payouts_enabled gate, same no-pending re-entry guard (SCOPED to
// source='affiliate'), same snapshot-before-insert, same MIN, same
// idempotency-keyed transfer, same chunkedInOrThrow loud-fail flip + FIX-A
// parking. The ONLY differences from the campaign rail:
//   1. source = 'affiliate' (the withdrawals insert + the no-pending guard), so
//      affiliate and campaign withdrawals don't cross-block (Stage 2a marker).
//   2. the snapshot source is transaction_settlements via
//      getAvailableAffiliateSettlements (rows + sum from ONE fetch, no drift).
//   3. the flip sets payout_status='paid' + withdrawal_id (not withdrawn_at),
//      guarded `.eq("payout_status","held")` so a row a refund flipped
//      held->refunded mid-flight is NOT re-marked paid; the confirmation re-read
//      parks on any count mismatch.
//
// MONEY MOVEMENT: stripe.transfers.create moves real funds in prod (sk_live). In
// dev STRIPE_SECRET_KEY is sk_test -> test-mode transfer, no real money. The
// idempotencyKey = withdrawalId so a retry returns the SAME transfer.

import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { verifySession } from "@/lib/dal";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { getStripe } from "@/lib/stripe/server";
import { enforce } from "@/lib/ratelimit";
import { chunkedInOrThrow } from "@/lib/queries/chunked-in";
import { getAvailableAffiliateSettlements } from "@/lib/affiliate/balance";

const MIN_WITHDRAWAL_CENTS = 1000;

export async function POST() {
  const session = await verifySession();
  const limit = await enforce(
    "userWrites",
    session.userId,
    "me/affiliate/withdraw",
  );
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
    return NextResponse.json({ error: "payouts_not_enabled" }, { status: 400 });
  }

  // No-pending guard SCOPED to source='affiliate' — a pending/parked AFFILIATE
  // withdrawal blocks; a pending CAMPAIGN one does NOT (different row set; the
  // Stage 2a source marker keeps the two rails from cross-blocking).
  const { data: blocking } = await supabase
    .from("withdrawals")
    .select("id, status")
    .eq("creator_id", creator.id)
    .eq("source", "affiliate")
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

  // Snapshot the AVAILABLE settlements (matured held cuts) — rows + sum from ONE
  // fetch, so total_cents === sum(rows). Captured BEFORE the insert so we know
  // exactly which rows the transfer covers even if a new cut matures mid-flight.
  const { rows, total_cents: totalCents } =
    await getAvailableAffiliateSettlements(creator.id);
  if (totalCents < MIN_WITHDRAWAL_CENTS) {
    return NextResponse.json(
      {
        error: "below_minimum",
        available_cents: totalCents,
        minimum_cents: MIN_WITHDRAWAL_CENTS,
      },
      { status: 400 },
    );
  }
  const settlementIdsToPay = rows.map((r) => r.id);

  // Insert the withdrawal row first so we have an id for idempotency.
  const { data: withdrawalInserted, error: insErr } = await supabase
    .from("withdrawals")
    .insert({
      creator_id: creator.id,
      amount_cents: totalCents,
      status: "pending",
      source: "affiliate",
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

  // THE MONEY MOVE — synchronous. sk_test in dev (no real money), sk_live in
  // prod. idempotencyKey = withdrawalId: a retry returns the SAME transfer.
  const stripe = getStripe();
  let transfer: Stripe.Transfer;
  try {
    transfer = await stripe.transfers.create(
      {
        amount: totalCents,
        currency: "usd",
        destination: acct.stripe_connect_account_id as string,
        description: `Moonbeem affiliate earnings (${settlementIdsToPay.length} cuts)`,
        metadata: {
          moonbeem_withdrawal_id: withdrawalId,
          moonbeem_creator_id: creator.id,
          moonbeem_source: "affiliate",
        },
      },
      { idempotencyKey: withdrawalId },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "stripe_error";
    console.error(
      `[affiliate-payout] transfer failed for withdrawal=${withdrawalId}: ${msg}`,
    );
    // No money moved — settlements stay 'held' (no withdrawal_id set), retryable.
    await supabase
      .from("withdrawals")
      .update({ status: "failed", completed_at: new Date().toISOString() })
      .eq("id", withdrawalId);
    return NextResponse.json(
      { error: "transfer_failed", detail: msg },
      { status: 502 },
    );
  }

  // Stripe succeeded — the money has moved. Flip the SNAPSHOT settlement ids
  // 'held'->'paid' + stamp withdrawal_id, CHUNKED <=100 with LOUD-FAIL
  // (chunkedInOrThrow). Target the SNAPSHOT ids (not a re-query — which could
  // pick up cuts that matured after the snapshot). The `.eq("payout_status",
  // "held")` guards a cut a refund flipped held->refunded mid-flight: it won't be
  // re-marked paid, and the confirmation re-read then parks. Mirrors the campaign
  // rail's FIX-A discipline exactly (a degrade-to-empty helper would leave cuts
  // 'held' -> RE-PAID on the next withdrawal).
  const withdrawnAt = new Date().toISOString();

  const parkForReconciliation = async (reason: string) => {
    console.error(
      `[affiliate-payout] RECONCILE-REQUIRED withdrawal=${withdrawalId} transfer=${transfer.id} ` +
        `${reason} (money moved AFTER successful transfer): ` +
        `settlement_ids=[${settlementIdsToPay.join(",")}]`,
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

  let flippedIds: string[];
  try {
    const flipped = await chunkedInOrThrow<{ id: string }>(
      settlementIdsToPay,
      "affiliate-withdraw.flip",
      (chunk) =>
        supabase
          .from("transaction_settlements")
          .update({ payout_status: "paid", withdrawal_id: withdrawalId })
          .in("id", chunk)
          .eq("payout_status", "held") // race-guard: skip a mid-flight refund
          .select("id"),
    );
    flippedIds = flipped.map((r) => r.id);
  } catch (flipErr) {
    return parkForReconciliation(
      `flip chunk failed: ${
        flipErr instanceof Error ? flipErr.message : "flip_error"
      }`,
    );
  }

  // Confirmation re-read: the flip must have paid EXACTLY the snapshot set. Fewer
  // flipped (a cut flipped held->refunded between snapshot and flip, skipped by
  // the held guard) must NOT be 'completed' — the transfer paid the full amount
  // but a cut is now refunded -> over-paid -> manual reconcile.
  if (flippedIds.length !== settlementIdsToPay.length) {
    return parkForReconciliation(
      `partial flip: paid ${flippedIds.length} of ${settlementIdsToPay.length} cuts`,
    );
  }

  // Flip confirmed complete — the ONLY path to 'completed'.
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
    settlements_paid: flippedIds.length,
  });
}
