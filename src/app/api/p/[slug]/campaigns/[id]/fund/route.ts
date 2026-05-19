// Partner-admin endpoint that starts a funding attempt for a draft
// campaign.
//
// POST /api/p/[slug]/campaigns/[id]/fund
// Body: none (empty object or no body).
//
// Auth: caller must be in partner_users with role='admin' for this
// partner. Viewer role cannot fund. super_admin bypasses (mirrors
// the 3a campaign-create endpoint).
//
// Flow:
//   1. Authn/authz; resolve partner; validate campaign is owned by
//      this partner and is status='draft'.
//   2. Resolve-or-create partners.stripe_customer_id (race-guarded
//      the same way creator-onboarding guards its mirror insert at
//      src/app/api/me/payouts/onboard/route.ts:83-100).
//   3. Compute fee_cents from campaigns.moonbeem_fee_pct; the partner
//      is charged amount_cents + fee_cents.
//   4. INSERT a FRESH campaign_funding row in 'pending' to get the
//      row id before calling Stripe. Multiple funding attempts on the
//      same campaign create multiple rows; we NEVER reuse, revive, or
//      update a prior 'failed' row. The RPC's 'already_failed' guard
//      depends on this — a failed row must never be the one
//      confirm_campaign_funding is called against.
//   5. Create a Stripe Checkout session in 'payment' mode using the
//      campaign_funding row id as the Idempotency-Key. The session
//      metadata (and the underlying PaymentIntent metadata) carry
//      moonbeem_campaign_funding_id so the webhook handler can find
//      this row without a payment-intent-id lookup.
//   6. UPDATE the campaign_funding row with the resulting
//      stripe_payment_intent_id.
//   7. Return the Checkout URL. The client redirects the browser.
//
// CRITICAL: this endpoint NEVER flips campaigns.status. The webhook ->
// confirm_campaign_funding RPC path is the only thing that moves a
// campaign to 'funded'. Money-correctness contract.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentProfile, getUser } from "@/lib/dal";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { getStripe } from "@/lib/stripe/server";
import { enforce } from "@/lib/ratelimit";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Same publicBaseUrl shape as onboard/route.ts. Stripe echoes the
// URLs back verbatim, so a misconfigured NEXT_PUBLIC_SITE_URL lands
// users on localhost in prod. Defensive: prefer the env var only
// when it isn't localhost; otherwise use the request's actual origin
// (correct in both dev and prod).
function publicBaseUrl(request: NextRequest): string {
  const env = process.env.NEXT_PUBLIC_SITE_URL;
  if (env && !env.includes("localhost") && !env.includes("127.0.0.1")) {
    return env.replace(/\/$/, "");
  }
  return request.nextUrl.origin;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string; id: string }> },
) {
  const user = await getUser();
  if (!user) {
    return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  }
  const limit = await enforce("partnerWrites", user.id, "p/campaigns/fund");
  if (!limit.ok) return limit.response;
  const { slug, id } = await params;

  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  const supabase = createServiceRoleClient();

  const { data: partner } = await supabase
    .from("partners")
    .select("id, name, stripe_customer_id")
    .eq("slug", slug)
    .maybeSingle();
  if (!partner) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // super_admin bypasses partner_users check (matches /p/[slug] +
  // 3a campaigns endpoint). Otherwise the caller must be a
  // partner_users member with role='admin'. Viewer-role cannot fund.
  const profile = await getCurrentProfile();
  if (profile?.role !== "super_admin") {
    const { data: membership } = await supabase
      .from("partner_users")
      .select("role")
      .eq("partner_id", partner.id)
      .eq("user_id", user.id)
      .is("deleted_at", null)
      .maybeSingle();
    if (!membership || membership.role !== "admin") {
      return NextResponse.json({ error: "not_authorized" }, { status: 403 });
    }
  }

  // Campaign existence + partner ownership + status='draft' check.
  // Treat "wrong partner" as not_found so we don't leak existence to
  // a partner-admin from a different partner.
  const { data: campaign } = await supabase
    .from("campaigns")
    .select(
      "id, name, partner_id, status, budget_pool_cents, moonbeem_fee_pct",
    )
    .eq("id", id)
    .maybeSingle();
  if (!campaign || campaign.partner_id !== partner.id) {
    return NextResponse.json({ error: "campaign_not_found" }, { status: 404 });
  }
  if (campaign.status !== "draft") {
    return NextResponse.json(
      { error: "invalid_state", status: campaign.status },
      { status: 409 },
    );
  }

  // Concurrent-funding guard. If a pending campaign_funding row
  // already exists for this campaign, block creating a second one —
  // two live Checkout sessions for the same campaign is the
  // double-fund scenario (two paid sessions → two credit attempts).
  // The Part C RPC backstop catches this at the database level, but
  // this application-layer check is the friendlier user-facing
  // signal: a partner who clicks Fund twice (multi-tab or accidental
  // refresh) gets a clear 409 instead of a second session URL.
  //
  // No staleness window. Rationale: Stage 3 Part A's
  // checkout.session.expired handler flips abandoned-pending rows to
  // 'failed' at Stripe's natural session expiration (~24h default),
  // which unblocks the campaign. Stripe's webhook delivery is
  // exhaustive (long-tail retries), so a row that's stuck pending
  // past 24h indicates a real operational anomaly worth surfacing —
  // not something to paper over with a time window that could allow
  // a genuine in-flight payment to be bypassed. Worst case partner-
  // side: a 24h block after abandoning a Checkout session, which is
  // acceptable for v1 and can be tightened later (e.g. by shortening
  // checkout session expires_at, or by manual ops cleanup).
  const { data: existingPending } = await supabase
    .from("campaign_funding")
    .select("id, created_at")
    .eq("campaign_id", campaign.id)
    .eq("status", "pending")
    .maybeSingle();
  if (existingPending) {
    return NextResponse.json(
      {
        error: "funding_already_in_progress",
        existing_funding_id: existingPending.id,
      },
      { status: 409 },
    );
  }

  // Fee math. moonbeem_fee_pct is a Postgres numeric and may come
  // back from supabase-js as a string; Number() handles either.
  // Math.round is explicit so a half-cent doesn't silently truncate
  // (typical pool sizes are well within JS integer safety).
  const amountCents = campaign.budget_pool_cents as number;
  const feePct = Number(campaign.moonbeem_fee_pct);
  const feeCents = Math.round(amountCents * feePct);
  const chargeTotal = amountCents + feeCents;

  // Resolve-or-create the Stripe Customer for this partner.
  const stripe = getStripe();
  let customerId = partner.stripe_customer_id as string | null;
  if (!customerId) {
    let created;
    try {
      created = await stripe.customers.create({
        name: partner.name as string,
        metadata: { moonbeem_partner_id: partner.id as string },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "stripe_error";
      console.error(
        `[campaigns-fund] customers.create failed for partner=${partner.id}: ${msg}`,
      );
      return NextResponse.json(
        { error: "stripe_error", detail: msg },
        { status: 502 },
      );
    }
    // Race guard: WHERE stripe_customer_id IS NULL serializes
    // concurrent fund calls. Loser refetches and uses whatever value
    // is there. Mirrors src/app/api/me/payouts/onboard/route.ts:83-100.
    const { data: updated } = await supabase
      .from("partners")
      .update({ stripe_customer_id: created.id })
      .eq("id", partner.id)
      .is("stripe_customer_id", null)
      .select("stripe_customer_id")
      .maybeSingle();
    if (updated?.stripe_customer_id) {
      customerId = updated.stripe_customer_id as string;
    } else {
      // Lost the race. Read whichever customer id won.
      const { data: refetch } = await supabase
        .from("partners")
        .select("stripe_customer_id")
        .eq("id", partner.id)
        .maybeSingle();
      if (refetch?.stripe_customer_id) {
        customerId = refetch.stripe_customer_id as string;
      } else {
        // Should not happen — we either won the UPDATE or another
        // call did. Log and surface to caller.
        console.error(
          `[campaigns-fund] stripe_customer_id race produced no winner for partner=${partner.id}`,
        );
        return NextResponse.json(
          { error: "customer_persist_failed" },
          { status: 500 },
        );
      }
    }
  }

  // Insert a FRESH campaign_funding row in 'pending'. Multiple
  // attempts on the same campaign produce multiple rows; we never
  // reuse, revive, or update a prior 'failed' row.
  const { data: insertedFunding, error: insertErr } = await supabase
    .from("campaign_funding")
    .insert({
      campaign_id: campaign.id,
      amount_cents: amountCents,
      fee_cents: feeCents,
      status: "pending",
    })
    .select("id")
    .single();
  if (insertErr || !insertedFunding) {
    return NextResponse.json(
      { error: insertErr?.message ?? "funding_insert_failed" },
      { status: 500 },
    );
  }
  const fundingId = insertedFunding.id as string;

  // Build success/cancel URLs. The partner lands back on the
  // dashboard with a query flag; the dashboard's client component
  // reads it and refreshes server data so the now-funded campaign
  // appears with its new status.
  const baseUrl = publicBaseUrl(request);
  const successUrl =
    `${baseUrl}/p/${slug}/dashboard?campaign_funded=${campaign.id}`;
  const cancelUrl =
    `${baseUrl}/p/${slug}/dashboard?campaign_funding_cancelled=${campaign.id}`;

  // Metadata round-trip: the webhook handler reads
  // moonbeem_campaign_funding_id from the Checkout Session (or its
  // underlying PaymentIntent) and uses it as the RPC's p_campaign_-
  // funding_id. Cleaner than a stripe_payment_intent_id lookup.
  const metadata = {
    moonbeem_campaign_funding_id: fundingId,
    moonbeem_campaign_id: campaign.id as string,
    moonbeem_partner_id: partner.id as string,
  };

  let session;
  try {
    session = await stripe.checkout.sessions.create(
      {
        mode: "payment",
        customer: customerId as string,
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: "usd",
              unit_amount: chargeTotal,
              product_data: {
                name: `Campaign funding: ${campaign.name as string}`,
              },
            },
          },
        ],
        success_url: successUrl,
        cancel_url: cancelUrl,
        metadata,
        payment_intent_data: { metadata },
      },
      // Idempotency-Key uses the campaign_funding row id. A retried
      // request (network blip, double-click) returns the same session
      // rather than creating a duplicate charge.
      { idempotencyKey: fundingId },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "stripe_error";
    console.error(
      `[campaigns-fund] checkout.sessions.create failed for funding=${fundingId}: ${msg}`,
    );
    // Mark the just-created pending row as failed so it never becomes
    // an orphan that the partner can't get past. Subsequent fund
    // attempts will create a fresh row (per the spec); this dead row
    // is auditable but never reusable. Stage 3's webhook handlers
    // perform the same pending→failed transition for expired/declined
    // sessions; this is the same semantic for "the session never even
    // got off the ground."
    await supabase
      .from("campaign_funding")
      .update({ status: "failed", updated_at: new Date().toISOString() })
      .eq("id", fundingId);
    return NextResponse.json(
      { error: "stripe_error", detail: msg },
      { status: 502 },
    );
  }

  // session.payment_intent can be a string id or an expanded object;
  // by default it's a string. Defensive on the shape.
  const piId = typeof session.payment_intent === "string"
    ? session.payment_intent
    : session.payment_intent?.id ?? null;
  if (piId) {
    const { error: piUpdErr } = await supabase
      .from("campaign_funding")
      .update({
        stripe_payment_intent_id: piId,
        updated_at: new Date().toISOString(),
      })
      .eq("id", fundingId);
    if (piUpdErr) {
      // Non-fatal — the metadata round-trip is the primary id link
      // the webhook handler uses; the column is a secondary index.
      console.error(
        `[campaigns-fund] failed to stamp payment_intent_id on funding=${fundingId}: ${piUpdErr.message}`,
      );
    }
  }

  return NextResponse.json({
    ok: true,
    campaign_funding_id: fundingId,
    checkout_url: session.url,
  });
}
