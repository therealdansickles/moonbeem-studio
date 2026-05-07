// POST /api/webhooks/stripe
//
// Verifies Stripe webhook signature and handles the events we
// subscribed to in the dashboard:
//
//   account.updated                    — connected-account state
//                                        changed; flip
//                                        onboarding_completed +
//                                        payouts_enabled.
//   account.application.deauthorized   — creator disconnected the
//                                        Connect account; flip
//                                        payouts_enabled false.
//   payout.paid                        — Stripe paid the connected
//                                        account out to its bank.
//                                        Informational.
//   payout.failed                      — bank-leg payout failed.
//                                        Informational; logged so
//                                        we can surface in UI later.
//
// We do NOT subscribe to transfer.* events — the withdrawal route
// handles transfer success/failure synchronously from the Stripe
// API response.

import { NextResponse, type NextRequest } from "next/server";
import type Stripe from "stripe";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { getStripe } from "@/lib/stripe/server";

export async function POST(request: NextRequest) {
  const signature = request.headers.get("stripe-signature");
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!signature || !secret) {
    return NextResponse.json({ error: "missing_signature_or_secret" }, {
      status: 400,
    });
  }

  // Stripe needs the RAW body for signature verification.
  const body = await request.text();
  const stripe = getStripe();

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, signature, secret);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    console.error(`[stripe-webhook] signature verification failed: ${msg}`);
    return NextResponse.json({ error: "bad_signature" }, { status: 400 });
  }

  const supabase = createServiceRoleClient();

  switch (event.type) {
    case "account.updated": {
      const account = event.data.object as Stripe.Account;
      // Connect account is "verified to receive transfers and
      // payouts" when both charges_enabled and payouts_enabled are
      // true on the Stripe-side account. details_submitted means
      // the user finished the onboarding form.
      const onboardingCompleted = !!account.details_submitted;
      const payoutsEnabled = !!account.charges_enabled &&
        !!account.payouts_enabled;
      const { error } = await supabase
        .from("creator_payout_accounts")
        .update({
          onboarding_completed: onboardingCompleted,
          payouts_enabled: payoutsEnabled,
          updated_at: new Date().toISOString(),
        })
        .eq("stripe_connect_account_id", account.id);
      if (error) {
        console.error(
          `[stripe-webhook] account.updated row update failed for ${account.id}: ${error.message}`,
        );
      }
      break;
    }

    case "account.application.deauthorized": {
      // event.data.object is the Application; the connected account
      // id is on event.account. Connected account revoked our
      // access; mark them as un-payable until they reconnect.
      const accountId = event.account ?? null;
      if (!accountId) {
        console.warn(
          "[stripe-webhook] deauthorize event missing event.account",
        );
        break;
      }
      const { error } = await supabase
        .from("creator_payout_accounts")
        .update({
          payouts_enabled: false,
          onboarding_completed: false,
          updated_at: new Date().toISOString(),
        })
        .eq("stripe_connect_account_id", accountId);
      if (error) {
        console.error(
          `[stripe-webhook] deauthorize row update failed for ${accountId}: ${error.message}`,
        );
      }
      break;
    }

    case "payout.paid":
    case "payout.failed": {
      // Informational only — these are the bank-leg events
      // (Stripe → creator's bank). Logged so we can surface in
      // the UI later if needed.
      const payout = event.data.object as Stripe.Payout;
      const acct = (event as { account?: string }).account;
      console.log(
        `[stripe-webhook] ${event.type} payout=${payout.id} amount=${payout.amount} ${payout.currency} account=${acct ?? "n/a"}`,
      );
      break;
    }

    default:
      // Subscribed events should be the only ones routed here, but
      // log unknowns rather than 4xx so Stripe doesn't keep
      // retrying on a permission boundary issue.
      console.log(`[stripe-webhook] unhandled event type: ${event.type}`);
  }

  return NextResponse.json({ received: true });
}
