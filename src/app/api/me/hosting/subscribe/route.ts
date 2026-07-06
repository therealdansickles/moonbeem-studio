// POST /api/me/hosting/subscribe — a CLAIMED CREATOR starts (or switches into) a
// paid hosting tier. Creates a Stripe Checkout session in SUBSCRIPTION mode for
// the tier's price and returns its URL; the resulting subscription is reflected
// into creator_subscriptions by the Stripe webhook (customer.subscription.*).
//
// Tier is resolved to a Stripe Price by the stable lookup_key `hosting_<tier>`
// (works identically in test + live — no per-env price-id config). creator_id
// rides in subscription_data.metadata so the webhook knows whose subscription it
// is; tier is later read from the price's lookup_key (authoritative on
// upgrade/downgrade). NO money value is set here — Stripe owns the amount.

import { NextResponse, type NextRequest } from "next/server";
import { getUser } from "@/lib/dal";
import { enforce } from "@/lib/ratelimit";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { getStripe } from "@/lib/stripe/server";
import { PAID_TIER_ORDER, type PaidTier } from "@/lib/creator-titles/tiers";

export async function POST(request: NextRequest) {
  const user = await getUser();
  if (!user) {
    return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  }
  const rl = await enforce("creatorWrites", user.id, "me/hosting/subscribe");
  if (!rl.ok) return rl.response;

  const supabase = createServiceRoleClient();
  const { data: creator } = await supabase
    .from("creators")
    .select("id")
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!creator) {
    return NextResponse.json({ error: "no_claimed_creator" }, { status: 403 });
  }

  // ONE-LIVE GUARD (server-side): a creator with a live (active|trialing)
  // subscription must NOT open a second Checkout — that would create a second
  // billed Stripe subscription (double-charge) which the webhook's one-live
  // unique then can't record. Tier changes go through the billing portal. The
  // UI already hides Subscribe when subscribed; this backstops a stale tab or a
  // direct POST.
  const { data: live } = await supabase
    .from("creator_subscriptions")
    .select("id")
    .eq("creator_id", creator.id)
    .in("status", ["active", "trialing"])
    .maybeSingle();
  if (live) {
    return NextResponse.json({ error: "already_subscribed" }, { status: 409 });
  }

  let body: { tier?: unknown };
  try {
    body = (await request.json()) as { tier?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const tier = body.tier;
  if (
    typeof tier !== "string" ||
    !(PAID_TIER_ORDER as readonly string[]).includes(tier)
  ) {
    return NextResponse.json({ error: "invalid_tier" }, { status: 400 });
  }

  let stripe: ReturnType<typeof getStripe>;
  try {
    stripe = getStripe();
  } catch {
    return NextResponse.json({ error: "stripe_not_configured" }, { status: 500 });
  }

  // Resolve the tier → Stripe Price by lookup_key.
  const prices = await stripe.prices.list({
    lookup_keys: [`hosting_${tier as PaidTier}`],
    active: true,
    limit: 1,
  });
  const price = prices.data[0];
  if (!price) {
    console.error(`[hosting-subscribe] no active price for hosting_${tier}`);
    return NextResponse.json({ error: "price_not_configured" }, { status: 500 });
  }

  // Reuse the creator's existing Stripe customer if we've seen one (keeps a
  // single customer across resubscribes); otherwise Checkout creates one.
  const { data: existing } = await supabase
    .from("creator_subscriptions")
    .select("stripe_customer_id")
    .eq("creator_id", creator.id)
    .not("stripe_customer_id", "is", null)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const customerId =
    (existing?.stripe_customer_id as string | null | undefined) ?? undefined;

  const origin =
    process.env.NEXT_PUBLIC_SITE_URL ??
    request.headers.get("origin") ??
    new URL(request.url).origin;

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: price.id, quantity: 1 }],
    ...(customerId ? { customer: customerId } : {}),
    subscription_data: {
      // The webhook reads moonbeem_creator_id from here; tier comes from the
      // price lookup_key so it stays correct through portal upgrades.
      metadata: { moonbeem_creator_id: creator.id as string },
    },
    success_url: `${origin}/me?hosting=subscribed`,
    cancel_url: `${origin}/me?hosting=cancelled`,
  });

  return NextResponse.json({ url: session.url });
}
