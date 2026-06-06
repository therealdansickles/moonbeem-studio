// POST /api/webhooks/stripe
//
// Verifies Stripe webhook signature and handles the events we
// subscribed to in the dashboard:
//
//   Creator-OUT rail (existing):
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
//   Partner-IN rail (campaigns v1 3b):
//   checkout.session.completed         — partner paid the funding
//                                        Checkout session. Call
//                                        confirm_campaign_funding
//                                        RPC with the funding row
//                                        id from session metadata.
//                                        Atomically credits the
//                                        ledger and flips campaign
//                                        to 'funded'.
//   checkout.session.expired           — Checkout session expired
//                                        (~24h default) without a
//                                        successful payment. Flip
//                                        the campaign_funding row
//                                        to 'failed'; campaign
//                                        stays 'draft'.
//   payment_intent.payment_failed      — card declined or otherwise
//                                        rejected. Same handling
//                                        as expired: flip the cf
//                                        row to 'failed'.
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
  // Two Stripe endpoints point at THIS same URL, each with its own signing
  // secret:
  //   - Connect-scope endpoint  → STRIPE_WEBHOOK_SECRET
  //       events: account.updated / account.application.deauthorized /
  //               payout.paid / payout.failed (fire on connected accounts)
  //   - account-scope endpoint  → STRIPE_WEBHOOK_SECRET_ACCOUNT
  //       events: checkout.session.completed / checkout.session.expired /
  //               payment_intent.payment_failed (the PLATFORM-scope funding
  //               charge; it only reaches us via this account endpoint)
  // Any one delivery is signed by exactly one of these secrets, so we try
  // each PRESENT secret in turn and accept the first that verifies. Both env
  // vars may not be set during rollout (e.g. STRIPE_WEBHOOK_SECRET_ACCOUNT
  // unset before the account endpoint's secret lands in Vercel) — we filter
  // to the secrets actually configured and fail closed if NONE is present.
  const secrets = [
    process.env.STRIPE_WEBHOOK_SECRET,
    process.env.STRIPE_WEBHOOK_SECRET_ACCOUNT,
  ].filter((s): s is string => typeof s === "string" && s.length > 0);
  if (!signature || secrets.length === 0) {
    return NextResponse.json({ error: "missing_signature_or_secret" }, {
      status: 400,
    });
  }

  // Stripe needs the RAW body for signature verification.
  const body = await request.text();
  const stripe = getStripe();

  let event: Stripe.Event | null = null;
  let lastErr = "unknown";
  for (const secret of secrets) {
    try {
      event = stripe.webhooks.constructEvent(body, signature, secret);
      break;
    } catch (err) {
      // constructEvent throws on a secret mismatch. Keep the error and try
      // the next present secret — do NOT short-circuit on the first failure,
      // or events signed by the other endpoint's secret would be rejected.
      lastErr = err instanceof Error ? err.message : "unknown";
    }
  }
  if (!event) {
    console.error(`[stripe-webhook] signature verification failed: ${lastErr}`);
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

    case "checkout.session.completed": {
      // Partner-IN: a campaign-funding Checkout session was paid.
      // Read the funding row id from session metadata (round-tripped
      // at session-create time by /api/p/[slug]/campaigns/[id]/fund),
      // then call confirm_campaign_funding which atomically:
      //   - flips campaign_funding pending -> succeeded (or, in the
      //     double-fund case, -> superseded)
      //   - inserts a campaign_ledger 'funding' row for the pool
      //   - flips campaigns draft -> funded + funded_at
      // The RPC is idempotent on replay; a redelivered event lands
      // on a 'succeeded' or 'superseded' row and short-circuits.
      const session = event.data.object as Stripe.Checkout.Session;
      const fundingId = session.metadata?.moonbeem_campaign_funding_id;
      if (!fundingId) {
        // Not a campaigns-funding session (or metadata didn't round-
        // trip). Stripe sends checkout.session.completed for any
        // Checkout in the account; ignoring sessions we don't own
        // is the right move. Ack 200 so Stripe doesn't retry.
        console.log(
          `[stripe-webhook] checkout.session.completed missing moonbeem_campaign_funding_id; session=${session.id}`,
        );
        break;
      }

      // Stamp the payment-intent id on the funding row. checkout
      // .sessions.create does NOT reliably populate
      // session.payment_intent synchronously in payment mode, so the
      // fund endpoint can't stamp it at create time — but this
      // completed event always carries it. Stamp only when the
      // column is still null so we never clobber an existing value.
      // Best-effort: a failure here is logged but does not block
      // funding confirmation (the metadata round-trip, not this
      // column, is the id link the RPC relies on).
      const piId = typeof session.payment_intent === "string"
        ? session.payment_intent
        : session.payment_intent?.id ?? null;
      if (piId) {
        const { error: stampErr } = await supabase
          .from("campaign_funding")
          .update({
            stripe_payment_intent_id: piId,
            updated_at: new Date().toISOString(),
          })
          .eq("id", fundingId)
          .is("stripe_payment_intent_id", null);
        if (stampErr) {
          console.error(
            `[stripe-webhook] failed to stamp payment_intent_id on funding=${fundingId}: ${stampErr.message}`,
          );
        }
      }

      const { data: campaignId, error: rpcErr } = await supabase.rpc(
        "confirm_campaign_funding",
        { p_campaign_funding_id: fundingId },
      );
      if (rpcErr) {
        const msg = rpcErr.message ?? "";
        // 'unknown_funding' = the metadata id doesn't match any row.
        // Corrupt event or hand-crafted webhook. Log loudly and ack
        // 200 so Stripe stops retrying. Any other raised exception
        // (already_failed / invalid_funding_state /
        // invalid_campaign_state) likewise indicates an event that
        // won't succeed on retry — ack 200 with a loud log.
        // Unexpected errors (e.g. DB connectivity) return 500 so
        // Stripe retries.
        const handledErrors = [
          "unknown_funding",
          "already_failed",
          "invalid_funding_state",
          "invalid_campaign_state",
        ];
        const isHandled = handledErrors.some((code) => msg.includes(code));
        if (isHandled) {
          console.error(
            `[stripe-webhook] confirm_campaign_funding raised handled exception for funding=${fundingId}: ${msg}`,
          );
          break;
        }
        console.error(
          `[stripe-webhook] confirm_campaign_funding unexpected error for funding=${fundingId}: ${msg}`,
        );
        return NextResponse.json({ error: "rpc_failed" }, { status: 500 });
      }
      console.log(
        `[stripe-webhook] confirm_campaign_funding ok funding=${fundingId} campaign=${campaignId ?? "n/a"}`,
      );
      break;
    }

    case "checkout.session.expired": {
      // Partner-IN: the Checkout session expired (default ~24h)
      // without a payment. Flip the campaign_funding row to 'failed'
      // so subsequent fund attempts on the same campaign can proceed
      // (Stage 2's concurrent-pending guard blocks new attempts
      // while a row stays 'pending'). Do NOT touch the ledger or
      // campaigns.status — the campaign stays 'draft'.
      const session = event.data.object as Stripe.Checkout.Session;
      const fundingId = session.metadata?.moonbeem_campaign_funding_id;
      if (!fundingId) {
        console.log(
          `[stripe-webhook] checkout.session.expired missing moonbeem_campaign_funding_id; session=${session.id}`,
        );
        break;
      }
      const { error } = await supabase
        .from("campaign_funding")
        .update({
          status: "failed",
          updated_at: new Date().toISOString(),
        })
        .eq("id", fundingId)
        .eq("status", "pending"); // only pending rows transition here
      if (error) {
        console.error(
          `[stripe-webhook] checkout.session.expired failed to mark funding=${fundingId} as failed: ${error.message}`,
        );
      }
      break;
    }

    case "payment_intent.payment_failed": {
      // Partner-IN: the underlying PaymentIntent was rejected (card
      // declined, etc). Same pending -> failed transition as
      // checkout.session.expired. PaymentIntent metadata was set in
      // the fund endpoint via payment_intent_data.metadata, so it
      // round-trips on the event.
      const pi = event.data.object as Stripe.PaymentIntent;
      const fundingId = pi.metadata?.moonbeem_campaign_funding_id;
      if (!fundingId) {
        console.log(
          `[stripe-webhook] payment_intent.payment_failed missing moonbeem_campaign_funding_id; pi=${pi.id}`,
        );
        break;
      }
      const { error } = await supabase
        .from("campaign_funding")
        .update({
          status: "failed",
          updated_at: new Date().toISOString(),
        })
        .eq("id", fundingId)
        .eq("status", "pending");
      if (error) {
        console.error(
          `[stripe-webhook] payment_intent.payment_failed failed to mark funding=${fundingId} as failed: ${error.message}`,
        );
      }
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
