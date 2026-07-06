// POST /api/me/hosting/billing-portal — a CLAIMED CREATOR with a hosting
// subscription opens the Stripe-hosted Billing Portal to upgrade, downgrade, or
// cancel. Stripe owns that UI; the resulting changes flow back through the
// customer.subscription.* webhook into creator_subscriptions. Returns the portal
// URL. NO money value is set here.

import { NextResponse, type NextRequest } from "next/server";
import { getUser } from "@/lib/dal";
import { enforce } from "@/lib/ratelimit";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { getStripe } from "@/lib/stripe/server";

export async function POST(request: NextRequest) {
  const user = await getUser();
  if (!user) {
    return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  }
  const rl = await enforce("creatorWrites", user.id, "me/hosting/billing-portal");
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

  // The creator's Stripe customer id, from any subscription row we've reflected.
  const { data: sub } = await supabase
    .from("creator_subscriptions")
    .select("stripe_customer_id")
    .eq("creator_id", creator.id)
    .not("stripe_customer_id", "is", null)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const customerId = sub?.stripe_customer_id as string | null | undefined;
  if (!customerId) {
    // No customer yet → nothing to manage. The UI should show Subscribe, not
    // Manage, in this state; guard anyway.
    return NextResponse.json({ error: "no_subscription" }, { status: 400 });
  }

  let stripe: ReturnType<typeof getStripe>;
  try {
    stripe = getStripe();
  } catch {
    return NextResponse.json({ error: "stripe_not_configured" }, { status: 500 });
  }

  const origin =
    process.env.NEXT_PUBLIC_SITE_URL ??
    request.headers.get("origin") ??
    new URL(request.url).origin;

  const portal = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: `${origin}/me`,
  });

  return NextResponse.json({ url: portal.url });
}
