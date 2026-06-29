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

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Stage 1: v2 thin-event support (ADDITIVE + INERT) ───────────────────────
// Accounts created via stripe.accounts.create at the pinned apiVersion are
// v2-managed and emit v2.core.account.* THIN events, not v1 account.updated — so
// the existing v1 flip never fires for them. This branch handles the recipient
// capability-status thin event and flips onboarding_completed / payouts_enabled,
// routed to the partner/creator table by the SAME metadata key the v1
// account.updated case uses. It is INERT until Stage 2 subscribes a v2
// event_destination (no v2 event can reach prod before that), and it runs ABOVE
// the v1 verification so a v2 payload never reaches constructEvent (which throws
// on thin events in SDK 22.x) — leaving the v1 path byte-for-byte unchanged.

const V2_RECIPIENT_CAP =
  "v2.core.account[configuration.recipient].capability_status_updated";

// Routing-only peek at the RAW payload — NOT verification (both branches verify
// the signature with the correct SDK method below). A v1 fat event always has
// object === "event"; only a v2 thin event has object === "v2.core.event", so a
// live v1 event can never be misrouted into the v2 parser.
function looksLikeV2ThinEvent(rawBody: string): boolean {
  try {
    const peek = JSON.parse(rawBody) as { object?: unknown; type?: unknown };
    return (
      peek.object === "v2.core.event" &&
      typeof peek.type === "string" &&
      peek.type.startsWith("v2.")
    );
  } catch {
    return false;
  }
}

async function handleV2AccountEvent(
  stripe: Stripe,
  body: string,
  signature: string,
  secrets: string[],
): Promise<NextResponse> {
  // Verify with parseEventNotification (v2), mirroring the v1 dual-secret loop.
  let notification:
    | ReturnType<typeof stripe.parseEventNotification>
    | null = null;
  let lastErr = "unknown";
  for (const secret of secrets) {
    try {
      notification = stripe.parseEventNotification(body, signature, secret);
      break;
    } catch (err) {
      lastErr = err instanceof Error ? err.message : "unknown";
    }
  }
  if (!notification) {
    console.error(
      `[stripe-webhook][v2] signature verification failed: ${lastErr}`,
    );
    return NextResponse.json({ error: "bad_signature" }, { status: 400 });
  }

  // Only the recipient capability-status event drives the payout flip. Ack any
  // other (currently unsubscribed) v2 event 200 so Stripe doesn't retry.
  if (notification.type !== V2_RECIPIENT_CAP) {
    console.log(`[stripe-webhook][v2] ignoring ${notification.type}`);
    return NextResponse.json({ received: true });
  }

  const accountId = notification.related_object?.id ?? null;
  if (!accountId) {
    console.warn(
      `[stripe-webhook][v2] ${notification.type} missing related_object id`,
    );
    return NextResponse.json({ received: true });
  }

  // Fetch the full v2 account WITH the recipient + merchant configurations.
  let account: Awaited<ReturnType<typeof stripe.v2.core.accounts.retrieve>>;
  try {
    account = await stripe.v2.core.accounts.retrieve(accountId, {
      include: ["configuration.recipient", "configuration.merchant"],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    console.error(
      `[stripe-webhook][v2] account retrieve failed acct=${accountId}: ${msg}`,
    );
    return NextResponse.json(
      { error: "v2_account_retrieve_failed" },
      { status: 500 },
    );
  }

  // payouts_enabled := BOTH recipient capabilities active, so money can flow all
  // the way to the distributor's bank rather than sitting in Stripe-balance limbo:
  //   - stripe_balance.stripe_transfers active -> a platform transfers.create
  //     ({destination}) lands in their Stripe balance (the withdraw route's call)
  //   - stripe_balance.payouts active -> that balance pays out to their bank
  const transfersStatus =
    account.configuration?.recipient?.capabilities?.stripe_balance
      ?.stripe_transfers?.status;
  const payoutsStatus =
    account.configuration?.recipient?.capabilities?.stripe_balance
      ?.payouts?.status;
  const payoutsEnabled =
    transfersStatus === "active" && payoutsStatus === "active";
  // onboarding_completed := v2 analogue of v1 details_submitted — recipient has
  // engaged transfer onboarding (status present and not 'unsupported'). UI-only.
  const onboardingCompleted =
    transfersStatus != null && transfersStatus !== "unsupported";

  const fields = {
    onboarding_completed: onboardingCompleted,
    payouts_enabled: payoutsEnabled,
    updated_at: new Date().toISOString(),
  };

  // Route by the SAME metadata keys the v1 account.updated case uses (that case
  // is left byte-unchanged; this branch carries its own copy of the routing).
  const supabase = createServiceRoleClient();
  if (account.metadata?.moonbeem_partner_id) {
    const { error } = await supabase
      .from("partner_payout_accounts")
      .update(fields)
      .eq("stripe_connect_account_id", accountId);
    if (error) {
      console.error(
        `[stripe-webhook][v2] partner update failed for ${accountId}: ${error.message}`,
      );
    }
  } else if (account.metadata?.moonbeem_creator_id) {
    const { error } = await supabase
      .from("creator_payout_accounts")
      .update(fields)
      .eq("stripe_connect_account_id", accountId);
    if (error) {
      console.error(
        `[stripe-webhook][v2] creator update failed for ${accountId}: ${error.message}`,
      );
    }
  } else {
    console.warn(
      `[stripe-webhook][v2] account ${accountId} has no moonbeem routing metadata; skipping`,
    );
  }

  console.log(
    `[stripe-webhook][v2] ${notification.type} acct=${accountId} transfers=${transfersStatus ?? "none"} payouts=${payoutsStatus ?? "none"} payouts_enabled=${payoutsEnabled}`,
  );
  return NextResponse.json({ received: true });
}

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

  // v2 thin-event branch (Stage 1: additive + INERT — no v2 subscription exists
  // yet, so no v2 event reaches prod until Stage 2). It MUST run above the v1
  // verification: SDK 22.x throws if a v2 thin event is fed to constructEvent, so
  // we route v2 away first and leave the v1 path below byte-for-byte unchanged.
  // The discriminator is routing-only (not verification) and can never misroute a
  // v1 fat event (object "event") into the v2 parser.
  if (looksLikeV2ThinEvent(body)) {
    return handleV2AccountEvent(stripe, body, signature, secrets);
  }

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
      const fields = {
        onboarding_completed: onboardingCompleted,
        payouts_enabled: payoutsEnabled,
        updated_at: new Date().toISOString(),
      };
      // Route by the metadata stamped at accounts.create: partner accounts
      // carry moonbeem_partner_id, creator accounts moonbeem_creator_id. Each
      // Connect account id belongs to exactly one table, so the routed update
      // lands on the owning row (matched by the UNIQUE stripe_connect_account_id).
      // No routing metadata => loud warn, never a silent cross-table miss.
      if (account.metadata?.moonbeem_partner_id) {
        const { error } = await supabase
          .from("partner_payout_accounts")
          .update(fields)
          .eq("stripe_connect_account_id", account.id);
        if (error) {
          console.error(
            `[stripe-webhook] account.updated partner update failed for ${account.id}: ${error.message}`,
          );
        }
      } else if (account.metadata?.moonbeem_creator_id) {
        const { error } = await supabase
          .from("creator_payout_accounts")
          .update(fields)
          .eq("stripe_connect_account_id", account.id);
        if (error) {
          console.error(
            `[stripe-webhook] account.updated creator update failed for ${account.id}: ${error.message}`,
          );
        }
      } else {
        console.warn(
          `[stripe-webhook] account.updated for ${account.id} has no moonbeem routing metadata (moonbeem_partner_id/moonbeem_creator_id); skipping`,
        );
      }
      break;
    }

    case "account.application.deauthorized": {
      // event.data.object is the Application; the connected account
      // id is on event.account. Connected account revoked our
      // access; mark them as un-payable until they reconnect.
      //
      // This payload does NOT carry our accounts.create metadata, so we route
      // by LOOKUP, not metadata: the account id is UNIQUE across both payout
      // tables, so try partner first and, only if it matched no row, try
      // creator. Exactly one table owns the id; the other update is a no-op.
      const accountId = event.account ?? null;
      if (!accountId) {
        console.warn(
          "[stripe-webhook] deauthorize event missing event.account",
        );
        break;
      }
      const fields = {
        payouts_enabled: false,
        onboarding_completed: false,
        updated_at: new Date().toISOString(),
      };
      const { data: partnerRows, error: partnerErr } = await supabase
        .from("partner_payout_accounts")
        .update(fields)
        .eq("stripe_connect_account_id", accountId)
        .select("id");
      if (partnerErr) {
        console.error(
          `[stripe-webhook] deauthorize partner update failed for ${accountId}: ${partnerErr.message}`,
        );
      }
      // Fall through to creator only when no partner row matched (0 rows).
      if (!partnerRows || partnerRows.length === 0) {
        const { error: creatorErr } = await supabase
          .from("creator_payout_accounts")
          .update(fields)
          .eq("stripe_connect_account_id", accountId);
        if (creatorErr) {
          console.error(
            `[stripe-webhook] deauthorize creator update failed for ${accountId}: ${creatorErr.message}`,
          );
        }
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
      // Viewer-IN (transactions su2 rental + su4 purchase): a rental OR purchase
      // Checkout was paid. Discriminated by moonbeem_kind ∈ {'rental','purchase'}
      // metadata. Grant the entitlement idempotently via grant_entitlement(kind)
      // — a replayed event returns 'already_granted', still 200; a genuine
      // (non-conflict) insert failure returns 500 so Stripe retries.
      // Campaign-funding sessions (moonbeem_campaign_funding_id, no
      // moonbeem_kind) fall through UNCHANGED to the partner-IN branch below.
      // Scoped in its own block so `session` doesn't collide with the partner-IN
      // `session` const, keeping that branch byte-for-byte unchanged.
      {
        const session = event.data.object as Stripe.Checkout.Session;
        const md = session.metadata;
        const moonbeemKind = md?.moonbeem_kind;
        if (md && (moonbeemKind === "rental" || moonbeemKind === "purchase")) {
          // Only grant once funds are settled. Card Checkout always completes
          // 'paid'; this guards against a future delayed/async method (e.g. bank
          // debit) firing completed while still 'unpaid' (which would otherwise
          // grant a free entitlement before — or instead of — settlement).
          if (session.payment_status !== "paid") {
            console.log(
              `[stripe-webhook] ${moonbeemKind} session not paid (status=${session.payment_status}); session=${session.id} — skipping grant`,
            );
            break;
          }
          const userId = md.moonbeem_user_id ?? "";
          const titleId = md.moonbeem_title_id ?? "";
          const priceCents = Number(md.moonbeem_price_cents);
          // Validate before granting. A malformed transaction event can never
          // succeed on retry → log loudly + ack 200 (don't make Stripe retry a
          // poisoned event forever). Price must be a positive safe integer (a $0
          // rental/purchase is nonsensical; the transact route enforces > 0). The
          // kind is already narrowed to 'rental' | 'purchase' by the branch guard.
          if (
            !UUID_RE.test(userId) ||
            !UUID_RE.test(titleId) ||
            !Number.isInteger(priceCents) ||
            priceCents <= 0 ||
            !Number.isSafeInteger(priceCents)
          ) {
            console.error(
              `[stripe-webhook] ${moonbeemKind} session malformed metadata; session=${session.id} user=${userId} title=${titleId} price=${md.moonbeem_price_cents}`,
            );
            break;
          }
          const piId =
            typeof session.payment_intent === "string"
              ? session.payment_intent
              : (session.payment_intent?.id ?? null);
          const { data: grantResult, error: grantErr } = await supabase.rpc(
            "grant_entitlement",
            {
              p_session_id: session.id,
              p_user_id: userId,
              p_title_id: titleId,
              p_kind: moonbeemKind,
              p_price_cents: priceCents,
              p_payment_intent_id: piId,
            },
          );
          if (grantErr) {
            // The ON CONFLICT no-op never errors; an error here is a genuine
            // failure (FK violation, bad kind, DB down). The customer paid → 500
            // so Stripe retries until the grant lands.
            console.error(
              `[stripe-webhook] grant_entitlement (${moonbeemKind}) failed; session=${session.id}: ${grantErr.message}`,
            );
            return NextResponse.json({ error: "grant_failed" }, { status: 500 });
          }
          // 'granted' (new) or 'already_granted' (idempotent replay) — ack 200.
          console.log(
            `[stripe-webhook] grant_entitlement ${grantResult} kind=${moonbeemKind} session=${session.id} user=${userId} title=${titleId}`,
          );
          break;
        }
      }

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

    case "charge.refunded": {
      // Sub-unit 5b feeder (c): a charge was refunded. Block payout on the
      // settlement AND revoke the buyer's access. Maps by payment_intent (the
      // only id a Charge event carries back to us) -> entitlement -> settlement.
      // Reads the event + writes our DB only — NO Stripe write, moves no money.
      const charge = event.data.object as Stripe.Charge;
      const piId =
        typeof charge.payment_intent === "string"
          ? charge.payment_intent
          : (charge.payment_intent?.id ?? null);
      if (!piId) {
        console.log(
          `[stripe-webhook] charge.refunded with no payment_intent; charge=${charge.id} — nothing to map`,
        );
        break;
      }
      // Fail-safe: block on ANY refund. A partial (amount_refunded < amount) is
      // unexpected for our single-full-charge rentals/purchases — log it and
      // block anyway (v1 treats any refund as payout-blocking; partial-amount
      // accounting is deferred).
      if (charge.amount_refunded < charge.amount) {
        console.warn(
          `[stripe-webhook] [refund] unexpected partial refund, blocking payout anyway; charge=${charge.id} refunded=${charge.amount_refunded}/${charge.amount}`,
        );
      }
      // The partial unique index on stripe_payment_intent_id makes this <=1 row.
      const { data: ent, error: entErr } = await supabase
        .from("entitlements")
        .select("id, revoked_at")
        .eq("stripe_payment_intent_id", piId)
        .maybeSingle();
      if (entErr) {
        console.error(
          `[stripe-webhook] [refund] entitlement lookup failed PI=${piId}: ${entErr.message}`,
        );
        return NextResponse.json({ error: "refund_lookup_failed" }, { status: 500 });
      }
      if (!ent) {
        console.log(
          `[stripe-webhook] [refund] no entitlement for PI ${piId}, likely non-transaction charge; charge=${charge.id}`,
        );
        break;
      }
      // Revoke access (idempotent: the IS NULL guard no-ops once revoked).
      const { error: revErr } = await supabase
        .from("entitlements")
        .update({ revoked_at: new Date().toISOString() })
        .eq("id", ent.id as string)
        .is("revoked_at", null);
      if (revErr) {
        console.error(
          `[stripe-webhook] [refund] revoke failed ent=${ent.id}: ${revErr.message}`,
        );
        return NextResponse.json({ error: "refund_revoke_failed" }, { status: 500 });
      }
      // Block payout on the settlement IF it exists. 0 rows = the not-yet-settled
      // race (the settle pass honors revoked_at later) OR a replay — both are
      // idempotent no-ops. 'reversed'/'refunded' rows are left as-is.
      const { error: setErr } = await supabase
        .from("transaction_settlements")
        .update({
          payout_status: "refunded",
          refunded_at: new Date().toISOString(),
        })
        .eq("entitlement_id", ent.id as string)
        .not("payout_status", "in", "(refunded,reversed)");
      if (setErr) {
        console.error(
          `[stripe-webhook] [refund] settlement block failed ent=${ent.id}: ${setErr.message}`,
        );
        return NextResponse.json({ error: "refund_block_failed" }, { status: 500 });
      }
      console.log(
        `[stripe-webhook] [refund] blocked payout + revoked access ent=${ent.id} PI=${piId} charge=${charge.id}`,
      );
      break;
    }

    case "charge.dispute.created": {
      // Sub-unit 5b feeder (c): a dispute (chargeback) opened. Block payout on
      // the settlement and mark the entitlement disputed, but DO NOT revoke
      // access — the claim is contested. Resolution (won/lost) is a manual
      // runbook, not handled here. Reads the event + writes our DB only.
      const dispute = event.data.object as Stripe.Dispute;
      const piId =
        typeof dispute.payment_intent === "string"
          ? dispute.payment_intent
          : (dispute.payment_intent?.id ?? null);
      const chargeId =
        typeof dispute.charge === "string"
          ? dispute.charge
          : (dispute.charge?.id ?? null);
      if (!piId) {
        console.log(
          `[stripe-webhook] charge.dispute.created with no payment_intent; dispute=${dispute.id} charge=${chargeId ?? "n/a"} — nothing to map`,
        );
        break;
      }
      const { data: ent, error: entErr } = await supabase
        .from("entitlements")
        .select("id, disputed_at")
        .eq("stripe_payment_intent_id", piId)
        .maybeSingle();
      if (entErr) {
        console.error(
          `[stripe-webhook] [dispute] entitlement lookup failed PI=${piId}: ${entErr.message}`,
        );
        return NextResponse.json({ error: "dispute_lookup_failed" }, { status: 500 });
      }
      if (!ent) {
        console.log(
          `[stripe-webhook] [dispute] no entitlement for PI ${piId}, likely non-transaction charge; dispute=${dispute.id}`,
        );
        break;
      }
      // Mark disputed — NO revoke (access continues). Idempotent via IS NULL.
      const { error: dispErr } = await supabase
        .from("entitlements")
        .update({ disputed_at: new Date().toISOString() })
        .eq("id", ent.id as string)
        .is("disputed_at", null);
      if (dispErr) {
        console.error(
          `[stripe-webhook] [dispute] mark failed ent=${ent.id}: ${dispErr.message}`,
        );
        return NextResponse.json({ error: "dispute_mark_failed" }, { status: 500 });
      }
      // Block payout if the settlement exists. 'refunded'/'reversed'/'disputed'
      // are left as-is (a refund already-blocked wins; replay is a no-op).
      const { error: setErr } = await supabase
        .from("transaction_settlements")
        .update({
          payout_status: "disputed",
          disputed_at: new Date().toISOString(),
        })
        .eq("entitlement_id", ent.id as string)
        .not("payout_status", "in", "(refunded,reversed,disputed)");
      if (setErr) {
        console.error(
          `[stripe-webhook] [dispute] settlement block failed ent=${ent.id}: ${setErr.message}`,
        );
        return NextResponse.json({ error: "dispute_block_failed" }, { status: 500 });
      }
      console.log(
        `[stripe-webhook] [dispute] blocked payout (access continues) ent=${ent.id} PI=${piId} dispute=${dispute.id}`,
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
