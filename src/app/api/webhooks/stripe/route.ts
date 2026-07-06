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

// Fetch a charge's hosted receipt_url + the actual Stripe processing fee, via the
// PaymentIntent's latest_charge. Best-effort — a null on any miss is fine (the
// receipt lazily backfills on Library click; the absorbed-fee is informational).
async function fetchChargeReceiptAndFee(
  stripe: Stripe,
  piId: string | null,
): Promise<{
  receiptUrl: string | null;
  feeCents: number | null;
  chargeRefunded: boolean;
  chargeDisputed: boolean;
}> {
  const empty = {
    receiptUrl: null,
    feeCents: null,
    chargeRefunded: false,
    chargeDisputed: false,
  };
  if (!piId) return empty;
  try {
    const pi = await stripe.paymentIntents.retrieve(piId, {
      expand: ["latest_charge.balance_transaction"],
    });
    const charge =
      pi.latest_charge && typeof pi.latest_charge === "object"
        ? (pi.latest_charge as Stripe.Charge)
        : null;
    const receiptUrl = charge?.receipt_url ?? null;
    const bt =
      charge && typeof charge.balance_transaction === "object"
        ? (charge.balance_transaction as Stripe.BalanceTransaction)
        : null;
    const feeCents = typeof bt?.fee === "number" ? bt.fee : null;
    return {
      receiptUrl,
      feeCents,
      chargeRefunded: charge?.refunded === true,
      chargeDisputed: charge?.disputed === true,
    };
  } catch (err) {
    console.error(
      `[stripe-webhook] fetchChargeReceiptAndFee failed PI=${piId}: ${err instanceof Error ? err.message : "unknown"}`,
    );
    return empty;
  }
}

// Clawback a TIP's settlement (policy C, keyed on tip_id) + mark the tip status,
// when a refund/dispute charge maps to a tip instead of an entitlement. Mirrors
// the entitlement clawback: paid -> reversed (absorb), held -> refunded/disputed.
// {ok:false} on a real DB error so the caller 500s (Stripe retries). No tip match
// = a genuinely non-transaction charge -> {ok:true}.
async function clawbackTip(
  supabase: ReturnType<typeof createServiceRoleClient>,
  piId: string,
  event: "refund" | "dispute",
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data: tip, error: tipErr } = await supabase
    .from("tips")
    .select("id, status")
    .eq("stripe_payment_intent_id", piId)
    .maybeSingle();
  if (tipErr) return { ok: false, error: `tip lookup: ${tipErr.message}` };
  if (!tip) return { ok: true };

  const nowIso = new Date().toISOString();
  const tipTerminal = event === "refund" ? "refunded" : "disputed";
  // Mark the tip status (refund wins over dispute; idempotent once terminal).
  const { error: statusErr } = await supabase
    .from("tips")
    .update({ status: tipTerminal })
    .eq("id", tip.id as string)
    .not(
      "status",
      "in",
      event === "refund" ? "(refunded)" : "(refunded,disputed)",
    );
  if (statusErr) return { ok: false, error: `tip status: ${statusErr.message}` };

  // A: a PAID cut -> reversed (absorb; no Stripe reversal).
  const { error: revErr } = await supabase
    .from("transaction_settlements")
    .update({ payout_status: "reversed", reversed_at: nowIso })
    .eq("tip_id", tip.id as string)
    .eq("payout_status", "paid");
  if (revErr) return { ok: false, error: `settlement reverse: ${revErr.message}` };

  // B: a not-yet-paid cut (held) -> refunded/disputed.
  const patch =
    event === "refund"
      ? { payout_status: "refunded", refunded_at: nowIso }
      : { payout_status: "disputed", disputed_at: nowIso };
  const excluded =
    event === "refund"
      ? "(refunded,reversed,paid)"
      : "(refunded,reversed,disputed,paid)";
  const { error: setErr } = await supabase
    .from("transaction_settlements")
    .update(patch)
    .eq("tip_id", tip.id as string)
    .not("payout_status", "in", excluded);
  if (setErr) return { ok: false, error: `settlement block: ${setErr.message}` };
  return { ok: true };
}

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

// ── Creator hosting subscriptions (Phase 3) ─────────────────────────────────
// Reflect the CURRENT state of a Stripe subscription into creator_subscriptions
// (the tier source of truth). Takes the subscription ID and RE-FETCHES the live
// object from Stripe rather than trusting the event payload: Stripe does not
// guarantee webhook ordering and retries for days, so a stale/out-of-order
// event must NOT be able to resurrect a canceled tier or land a stale tier.
// Re-fetching means every event simply writes the current truth — idempotent and
// order-independent.
//
// Tier is derived from the price's stable lookup_key (NOT metadata — the billing
// portal changes the price on upgrade/downgrade but not metadata). creator_id
// comes from metadata (fixed for the subscription's life). Idempotent: update-by-
// stripe_subscription_id then insert-on-miss, with the two unique constraints
// DISAMBIGUATED on 23505 (a stripe_subscription_id race is a benign idempotent
// ack; a one-live conflict means TWO live subscriptions for one creator — an
// anomaly the subscribe guard prevents — logged loudly, not silently dropped).
const HOSTING_LOOKUP_TO_TIER: Record<string, string> = {
  hosting_solo: "solo",
  hosting_studio: "studio",
  hosting_pro: "pro",
};
async function reflectCreatorSubscription(
  stripe: Stripe,
  supabase: ReturnType<typeof createServiceRoleClient>,
  subId: string,
): Promise<{ ok: boolean; skipped?: boolean; anomaly?: boolean; error?: string }> {
  // Re-fetch the authoritative current state (defeats out-of-order/redelivered
  // events). A canceled subscription is still retrievable at Stripe.
  let sub: Stripe.Subscription;
  try {
    sub = await stripe.subscriptions.retrieve(subId, {
      expand: ["items.data.price"],
    });
  } catch (err) {
    const statusCode = (err as { statusCode?: number })?.statusCode ?? null;
    if (statusCode === 404) {
      // Gone at Stripe → ensure any local row for this sub reads 'canceled' so
      // getCreatorTier drops to free. No local row → matches 0, no-op.
      await supabase
        .from("creator_subscriptions")
        .update({ status: "canceled", updated_at: new Date().toISOString() })
        .eq("stripe_subscription_id", subId);
      return { ok: true };
    }
    // Transient (network/5xx) → surface so Stripe retries.
    return {
      ok: false,
      error: err instanceof Error ? err.message : "subscription_retrieve_failed",
    };
  }

  const creatorId = sub.metadata?.moonbeem_creator_id ?? "";
  const lookupKey =
    (sub.items?.data?.[0]?.price as Stripe.Price | undefined)?.lookup_key ?? "";
  const tier = HOSTING_LOOKUP_TO_TIER[lookupKey] ?? "";
  if (!UUID_RE.test(creatorId) || !tier) {
    // Not one of our hosting subscriptions (or malformed) — ack, write nothing.
    return { ok: true, skipped: true };
  }
  const customerId =
    typeof sub.customer === "string" ? sub.customer : (sub.customer?.id ?? null);
  const priceId = sub.items?.data?.[0]?.price?.id ?? null;
  // current_period_end moved to the subscription ITEM in recent API versions;
  // read whichever is present. Informational (display), not gate-critical.
  const periodEndUnix =
    (sub.items?.data?.[0] as { current_period_end?: number } | undefined)
      ?.current_period_end ??
    (sub as { current_period_end?: number }).current_period_end ??
    null;
  const mutable = {
    tier,
    status: sub.status,
    stripe_customer_id: customerId,
    stripe_price_id: priceId,
    current_period_end:
      periodEndUnix != null ? new Date(periodEndUnix * 1000).toISOString() : null,
    cancel_at_period_end: !!sub.cancel_at_period_end,
    updated_at: new Date().toISOString(),
  };
  // Update the existing row for this subscription id (upgrade/downgrade/cancel).
  const { data: updated, error: uErr } = await supabase
    .from("creator_subscriptions")
    .update(mutable)
    .eq("stripe_subscription_id", sub.id)
    .select("id");
  if (uErr) {
    if (uErr.code === "23505" && uErr.message?.includes("one_live")) {
      // Setting THIS sub live would collide with another live sub for the same
      // creator — a two-active anomaly (the subscribe guard prevents it). Ack so
      // Stripe stops retrying; log loudly for reconciliation.
      console.error(
        `[stripe-webhook] one-live conflict updating sub=${sub.id} creator=${creatorId} — two live subscriptions; reconcile`,
      );
      return { ok: true, anomaly: true };
    }
    return { ok: false, error: uErr.message };
  }
  if (updated && updated.length > 0) return { ok: true };
  // No existing row → first delivery for this subscription → insert.
  const { error: iErr } = await supabase.from("creator_subscriptions").insert({
    creator_id: creatorId,
    stripe_subscription_id: sub.id,
    ...mutable,
  });
  if (iErr) {
    if (iErr.code === "23505") {
      if (iErr.message?.includes("one_live")) {
        // Another live subscription already exists for this creator → the NEW
        // one is not recorded. This is a genuine anomaly (double-subscribe the
        // guard should have blocked): ack so Stripe stops retrying, but log
        // loudly so it can be reconciled/refunded rather than silently dropped.
        console.error(
          `[stripe-webhook] one-live conflict inserting sub=${sub.id} creator=${creatorId} — a live subscription already exists; NEW sub unrecorded, reconcile/refund`,
        );
        return { ok: true, anomaly: true };
      }
      // stripe_subscription_id conflict = a concurrent insert of the SAME sub →
      // idempotent, safe to ack.
      return { ok: true };
    }
    return { ok: false, error: iErr.message };
  }
  return { ok: true };
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
  //   - v2 thin-payload destination → STRIPE_WEBHOOK_SECRET_V2
  //       events: v2.core.account[configuration.recipient].capability_status_updated
  //               (recipient capability status; flips payouts_enabled)
  // Any one delivery is signed by exactly one of these secrets, so we try
  // each PRESENT secret in turn and accept the first that verifies. Both env
  // vars may not be set during rollout (e.g. STRIPE_WEBHOOK_SECRET_ACCOUNT
  // unset before the account endpoint's secret lands in Vercel) — we filter
  // to the secrets actually configured and fail closed if NONE is present.
  const secrets = [
    process.env.STRIPE_WEBHOOK_SECRET,
    process.env.STRIPE_WEBHOOK_SECRET_ACCOUNT,
    process.env.STRIPE_WEBHOOK_SECRET_V2,
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
          // Affiliate attribution (Stage 1, INERT): nothing sets
          // moonbeem_creator_id in checkout metadata yet — Stage 3 (the cookie ->
          // rent-route -> metadata thread) does — so this is null on every grant
          // today, and grant_entitlement writes creator_id = NULL, exactly the
          // pre-attribution behavior. p_creator_id is trailing + defaulted, so a
          // null value (or an old 6-arg caller during the deploy window) is fine.
          const creatorId = md.moonbeem_creator_id ?? null;
          const { data: grantResult, error: grantErr } = await supabase.rpc(
            "grant_entitlement",
            {
              p_session_id: session.id,
              p_user_id: userId,
              p_title_id: titleId,
              p_kind: moonbeemKind,
              p_price_cents: priceCents,
              p_payment_intent_id: piId,
              p_creator_id: creatorId,
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
          // RECEIPT (Option A): capture the Stripe receipt_url so the Library
          // click path stays Stripe-free. Best-effort — a miss leaves NULL,
          // lazily backfilled on click. Idempotent via the receipt_url IS NULL
          // guard. Runs AFTER the grant (a receipt failure never blocks it).
          {
            const { receiptUrl } = await fetchChargeReceiptAndFee(stripe, piId);
            if (receiptUrl) {
              const { error: rErr } = await supabase
                .from("entitlements")
                .update({ receipt_url: receiptUrl })
                .eq("stripe_checkout_session_id", session.id)
                .is("receipt_url", null);
              if (rErr) {
                console.error(
                  `[stripe-webhook] receipt_url capture failed session=${session.id}: ${rErr.message}`,
                );
              }
            }
          }
          console.log(
            `[stripe-webhook] grant_entitlement ${grantResult} kind=${moonbeemKind} session=${session.id} user=${userId} title=${titleId}`,
          );
          break;
        }

        // Fan-IN (tips): a tip Checkout was paid. grant_tip marks the tip paid +
        // writes the settlement (creator owed 100%, Stripe fee absorbed),
        // idempotently. Capture the receipt + absorbed fee on the same event.
        if (md && moonbeemKind === "tip") {
          if (session.payment_status !== "paid") {
            console.log(
              `[stripe-webhook] tip session not paid (status=${session.payment_status}); session=${session.id} — skipping grant`,
            );
            break;
          }
          const tipId = md.moonbeem_tip_id ?? "";
          const amountCents = Number(md.moonbeem_amount_cents);
          if (
            !UUID_RE.test(tipId) ||
            !Number.isInteger(amountCents) ||
            amountCents <= 0 ||
            !Number.isSafeInteger(amountCents)
          ) {
            console.error(
              `[stripe-webhook] tip session malformed metadata; session=${session.id} tip=${tipId} amount=${md.moonbeem_amount_cents}`,
            );
            break;
          }
          const piId =
            typeof session.payment_intent === "string"
              ? session.payment_intent
              : (session.payment_intent?.id ?? null);
          const { receiptUrl, feeCents, chargeRefunded, chargeDisputed } =
            await fetchChargeReceiptAndFee(stripe, piId);
          const { data: grantResult, error: grantErr } = await supabase.rpc(
            "grant_tip",
            {
              p_tip_id: tipId,
              p_session_id: session.id,
              p_payment_intent_id: piId,
              p_receipt_url: receiptUrl,
              p_stripe_fee_absorbed_cents: feeCents,
            },
          );
          if (grantErr) {
            console.error(
              `[stripe-webhook] grant_tip failed; session=${session.id} tip=${tipId}: ${grantErr.message}`,
            );
            return NextResponse.json({ error: "grant_failed" }, { status: 500 });
          }
          console.log(
            `[stripe-webhook] grant_tip ${grantResult} tip=${tipId} session=${session.id} amount=${amountCents}`,
          );
          // Race guard: if the charge was ALREADY refunded/disputed at grant time
          // (an out-of-order refund/dispute delivered before this grant), block the
          // just-written 'held' tip settlement now — grant_tip stamped the PI, so
          // clawbackTip matches. Idempotent; mirrors the entitlement born-blocked
          // posture (which the settle cron does via revoked_at).
          if (piId && (chargeRefunded || chargeDisputed)) {
            const claw = await clawbackTip(
              supabase,
              piId,
              chargeRefunded ? "refund" : "dispute",
            );
            if (!claw.ok) {
              console.error(
                `[stripe-webhook] tip born-block clawback failed tip=${tipId}: ${claw.error}`,
              );
              return NextResponse.json({ error: "grant_failed" }, { status: 500 });
            }
            console.log(
              `[stripe-webhook] tip born-blocked (charge already ${chargeRefunded ? "refunded" : "disputed"}) tip=${tipId}`,
            );
          }
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
        // No entitlement -> maybe a TIP charge. Clawback its settlement (policy
        // C) + mark the tip refunded. A DB error 500s so Stripe retries.
        const tipClaw = await clawbackTip(supabase, piId, "refund");
        if (!tipClaw.ok) {
          console.error(
            `[stripe-webhook] [refund] tip clawback failed PI=${piId}: ${tipClaw.error}`,
          );
          return NextResponse.json({ error: "refund_block_failed" }, { status: 500 });
        }
        console.log(
          `[stripe-webhook] [refund] non-entitlement charge PI=${piId} (tip clawback applied if matched); charge=${charge.id}`,
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
      // CLAWBACK MARKING (Layer 3 Stage 3, policy C: ABSORB) — route the
      // settlement by its CURRENT payout_status (equivalent to
      // clawbackTargetStatus(status, 'refund') in lib/affiliate/clawback.ts):
      //   paid          -> reversed (the cut was ALREADY paid out to the curator;
      //                    ABSORB the funds — NO Stripe reversal, NO negative
      //                    carry. The 'reversed' marking + the withdrawal_id link
      //                    capture the exposure so an Option D recovery upgrade is
      //                    additive later; the 60-day hold on large cuts already
      //                    shrinks this case. KNOWN v1 EDGE: there is no
      //                    charge.dispute.closed handler, so a paid cut
      //                    disputed->reversed then WON stays 'reversed' — a record
      //                    discrepancy, no payout harm; correct manually.)
      //   held/disputed -> refunded (never paid; refund-wins over a held-origin
      //                    dispute; both are held-origin payout-blocked terminals)
      //   refunded/reversed -> no-op (idempotent on a re-delivered webhook)
      // Two DISJOINT guarded updates (A targets only 'paid'; B excludes 'paid'),
      // so they're order-independent and each no-ops once the row is terminal.
      // 0 rows from both = the not-yet-settled race (settle pass honors revoked_at
      // later) OR a replay — both idempotent no-ops.
      const nowIso = new Date().toISOString();
      // A: a PAID cut -> reversed (absorb).
      const { error: reverseErr } = await supabase
        .from("transaction_settlements")
        .update({ payout_status: "reversed", reversed_at: nowIso })
        .eq("entitlement_id", ent.id as string)
        .eq("payout_status", "paid");
      if (reverseErr) {
        console.error(
          `[stripe-webhook] [refund] settlement reverse failed ent=${ent.id}: ${reverseErr.message}`,
        );
        return NextResponse.json({ error: "refund_block_failed" }, { status: 500 });
      }
      // B: a not-yet-paid cut (held/disputed) -> refunded. 'paid' is now EXCLUDED
      // (handled by A); 'refunded'/'reversed' stay terminal (idempotent no-op).
      const { error: setErr } = await supabase
        .from("transaction_settlements")
        .update({ payout_status: "refunded", refunded_at: nowIso })
        .eq("entitlement_id", ent.id as string)
        .not("payout_status", "in", "(refunded,reversed,paid)");
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
        // No entitlement -> maybe a TIP charge. Clawback its settlement (policy
        // C) + mark the tip disputed. A DB error 500s so Stripe retries.
        const tipClaw = await clawbackTip(supabase, piId, "dispute");
        if (!tipClaw.ok) {
          console.error(
            `[stripe-webhook] [dispute] tip clawback failed PI=${piId}: ${tipClaw.error}`,
          );
          return NextResponse.json({ error: "dispute_block_failed" }, { status: 500 });
        }
        console.log(
          `[stripe-webhook] [dispute] non-entitlement charge PI=${piId} (tip clawback applied if matched); dispute=${dispute.id}`,
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
      // CLAWBACK MARKING (Layer 3 Stage 3, policy C: ABSORB) — route the
      // settlement by its CURRENT payout_status (equivalent to
      // clawbackTargetStatus(status, 'dispute') in lib/affiliate/clawback.ts):
      //   paid    -> reversed (ALREADY paid out; ABSORB — no Stripe reversal, no
      //              negative carry; see the charge.refunded handler's note + the
      //              KNOWN v1 EDGE: no charge.dispute.closed handler, so a paid cut
      //              disputed->reversed then WON stays 'reversed'.)
      //   held    -> disputed (never paid; payout-blocked, access continues)
      //   refunded/reversed/disputed -> no-op (a refund already-blocked wins;
      //              replay is a no-op — idempotent on re-delivery)
      // Two DISJOINT guarded updates (A targets only 'paid'; B excludes 'paid').
      const nowIso = new Date().toISOString();
      // A: a PAID cut -> reversed (absorb).
      const { error: reverseErr } = await supabase
        .from("transaction_settlements")
        .update({ payout_status: "reversed", reversed_at: nowIso })
        .eq("entitlement_id", ent.id as string)
        .eq("payout_status", "paid");
      if (reverseErr) {
        console.error(
          `[stripe-webhook] [dispute] settlement reverse failed ent=${ent.id}: ${reverseErr.message}`,
        );
        return NextResponse.json({ error: "dispute_block_failed" }, { status: 500 });
      }
      // B: a not-yet-paid cut (held) -> disputed. 'paid' is now EXCLUDED (handled
      // by A); 'refunded'/'reversed'/'disputed' stay terminal (idempotent no-op).
      const { error: setErr } = await supabase
        .from("transaction_settlements")
        .update({ payout_status: "disputed", disputed_at: nowIso })
        .eq("entitlement_id", ent.id as string)
        .not("payout_status", "in", "(refunded,reversed,disputed,paid)");
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

    // ── Creator hosting subscriptions (Phase 3) ──
    case "customer.subscription.created":
    case "customer.subscription.updated": {
      // Subscribe / upgrade / downgrade / cancel-flag / renew — Stripe sends the
      // full subscription object with its current status + price. Reflect it into
      // creator_subscriptions so getCreatorTier() sees the live tier. Idempotent.
      const sub = event.data.object as Stripe.Subscription;
      const r = await reflectCreatorSubscription(stripe, supabase, sub.id);
      if (!r.ok) {
        console.error(
          `[stripe-webhook] subscription reflect failed sub=${sub.id}: ${r.error}`,
        );
        return NextResponse.json(
          { error: "subscription_reflect_failed" },
          { status: 500 },
        );
      }
      console.log(
        `[stripe-webhook] ${event.type} sub=${sub.id}${r.skipped ? " (not-ours)" : r.anomaly ? " (anomaly)" : ""}`,
      );
      break;
    }

    case "customer.subscription.deleted": {
      // Subscription fully ended. Re-fetch confirms 'canceled' — not in the
      // active|trialing set getCreatorTier queries, so the creator drops to
      // 'free' (existing content keeps playing; only new uploads gate — D4).
      const sub = event.data.object as Stripe.Subscription;
      const r = await reflectCreatorSubscription(stripe, supabase, sub.id);
      if (!r.ok) {
        console.error(
          `[stripe-webhook] subscription delete reflect failed sub=${sub.id}: ${r.error}`,
        );
        return NextResponse.json(
          { error: "subscription_reflect_failed" },
          { status: 500 },
        );
      }
      console.log(
        `[stripe-webhook] customer.subscription.deleted sub=${sub.id}${r.skipped ? " (not-ours)" : ""}`,
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
