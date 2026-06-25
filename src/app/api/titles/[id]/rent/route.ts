// POST /api/titles/[id]/rent — start a Stripe Checkout to rent a film.
//
// The FIRST money-IN viewer flow (transactions sub-unit 2). Any AUTHENTICATED
// viewer may rent: getUser() → 401 if anon — NOT authorizeTitleMutation (that is
// the partner-admin gate; a renter is a fan, not a title owner). Mirrors the
// campaign fund route's Checkout shape (mode:'payment', integer-cents
// unit_amount, metadata on BOTH session + payment_intent_data) but charges the
// viewer as a GUEST (customer_email, no saved Stripe Customer). Returns
// { checkout_url }.
//
// No double-pay:
//   1. The webhook grants the entitlement EXACTLY ONCE, keyed on the Stripe
//      session id (sub-unit 2's grant_rental_entitlement, ON CONFLICT DO NOTHING).
//   2. BEFORE creating a Checkout, short-circuit if the viewer already holds an
//      ACTIVE rental (the two-clock window) → return { already_entitled } so they
//      are sent to play, not charged again.
//   3. The Stripe idempotencyKey is stable per (user, title, price) so a
//      double-click within Stripe's 24h window returns the SAME session, not a
//      second charge.
// (A rare simultaneous two-session double-pay is the documented refundable edge,
// same posture as the campaign double-fund.)
//
// This route GRANTS nothing and gates NO playback — the rent-vs-play playback
// gate is sub-unit 3. integer cents only; no float ever reaches Stripe or the DB.

import { NextResponse, type NextRequest } from "next/server";
import { getUser } from "@/lib/dal";
import { enforce } from "@/lib/ratelimit";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { getStripe } from "@/lib/stripe/server";
import { isEntitlementActive } from "@/lib/entitlements/window";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Same defensive base-url shape as the fund/onboard routes: prefer the env var
// unless it's localhost, else the request origin.
function publicBaseUrl(request: NextRequest): string {
  const env = process.env.NEXT_PUBLIC_SITE_URL;
  if (env && !env.includes("localhost") && !env.includes("127.0.0.1")) {
    return env.replace(/\/$/, "");
  }
  return request.nextUrl.origin;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  // Any authenticated viewer may rent — the entitlement keys on user_id.
  const user = await getUser();
  if (!user) {
    return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  }
  // Viewer-facing bucket (NOT partnerWrites).
  const rl = await enforce("standardAnon", user.id, "titles/rent");
  if (!rl.ok) return rl.response;

  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "title_not_found" }, { status: 404 });
  }

  const supabase = createServiceRoleClient();

  // Load the offer. Must be transact_enabled with a positive integer price.
  const { data: title } = await supabase
    .from("titles")
    .select("id, slug, title, transact_enabled, transact_price_cents")
    .eq("id", id)
    .maybeSingle();
  if (!title) {
    return NextResponse.json({ error: "title_not_found" }, { status: 404 });
  }
  const priceCents = title.transact_price_cents as number | null;
  if (
    title.transact_enabled !== true ||
    typeof priceCents !== "number" ||
    !Number.isInteger(priceCents) ||
    priceCents <= 0
  ) {
    return NextResponse.json({ error: "not_rentable" }, { status: 400 });
  }

  // DOUBLE-PAY GUARD: if the viewer already holds an active rental, don't charge.
  const { data: existing } = await supabase
    .from("entitlements")
    .select("kind, purchased_at, first_played_at")
    .eq("user_id", user.id)
    .eq("title_id", id)
    .order("purchased_at", { ascending: false })
    .limit(5);
  const alreadyActive = (existing ?? []).some((e) =>
    isEntitlementActive({
      kind: e.kind as string,
      purchased_at: e.purchased_at as string,
      first_played_at: (e.first_played_at as string | null) ?? null,
    }),
  );
  if (alreadyActive) {
    return NextResponse.json({ already_entitled: true });
  }

  const stripe = getStripe();
  const baseUrl = publicBaseUrl(request);
  const slug = title.slug as string;
  const successUrl = `${baseUrl}/t/${slug}?rented=1`;
  const cancelUrl = `${baseUrl}/t/${slug}?rent_cancelled=1`;

  // Metadata round-trips to the webhook (read off session OR payment_intent).
  // All values are strings (Stripe metadata is string→string); the webhook
  // re-parses moonbeem_price_cents to an integer and re-validates.
  const metadata = {
    moonbeem_kind: "rental",
    moonbeem_user_id: user.id,
    moonbeem_title_id: id,
    moonbeem_price_cents: String(priceCents),
  };

  let session;
  try {
    session = await stripe.checkout.sessions.create(
      {
        mode: "payment",
        customer_email: user.email ?? undefined, // guest checkout
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: "usd",
              unit_amount: priceCents, // integer cents, directly (no fee math)
              product_data: { name: `Rental: ${title.title as string}` },
            },
          },
        ],
        success_url: successUrl,
        cancel_url: cancelUrl,
        metadata,
        payment_intent_data: { metadata },
      },
      // Stable per (user, title, price): a double-click within Stripe's 24h
      // idempotency window returns the SAME session, never a second charge. The
      // price is in the key so a partner price change mints a fresh session
      // rather than erroring on a reused key.
      { idempotencyKey: `rent-${user.id}-${id}-${priceCents}` },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "stripe_error";
    console.error(`[titles/${id}/rent] checkout.sessions.create failed: ${msg}`);
    return NextResponse.json({ error: "stripe_error" }, { status: 502 });
  }

  return NextResponse.json({ checkout_url: session.url });
}
