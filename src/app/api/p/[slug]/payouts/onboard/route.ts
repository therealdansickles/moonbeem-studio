// POST /api/p/[slug]/payouts/onboard
//
// Partner-side clone of the creator payout onboarding
// (src/app/api/me/payouts/onboard/route.ts). Creates a Stripe Connect STANDARD
// account for the PARTNER (or reuses the one on file), then returns a fresh
// Account Link the client uses to redirect into Stripe-hosted onboarding.
//
// INERT — B1 moves no money. It only records the Connect account + its
// verification flags; the transfer/release leg is B2.
//
// The ONE non-clone vs the creator rail is AUTH: a partner is an org with M:N
// membership (partner_users), not a 1:1 user account. So this route is
// slug-scoped and gated super_admin OR partner_users role='admin' — the exact
// gate the other /api/p/[slug]/* write routes use (see campaigns/route.ts).

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentProfile, getUser } from "@/lib/dal";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { getStripe } from "@/lib/stripe/server";
import { enforce } from "@/lib/ratelimit";

// Same defensive base-url shape as the creator onboard + fund routes: prefer
// NEXT_PUBLIC_SITE_URL unless it's localhost, else the request origin.
function publicBaseUrl(request: NextRequest): string {
  const env = process.env.NEXT_PUBLIC_SITE_URL;
  if (env && !env.includes("localhost") && !env.includes("127.0.0.1")) {
    return env.replace(/\/$/, "");
  }
  return request.nextUrl.origin;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const user = await getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const limit = await enforce("partnerWrites", user.id, "p/payouts/onboard");
  if (!limit.ok) return limit.response;
  const { slug } = await params;
  const supabase = createServiceRoleClient();

  const { data: partner } = await supabase
    .from("partners")
    .select("id")
    .eq("slug", slug)
    .maybeSingle();
  if (!partner) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // super_admin bypasses partner_users; otherwise the caller must be a live
  // partner_users member with role='admin' (mirrors campaigns/route.ts:75-87).
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

  // Reuse the partner's existing Connect account if one is already on file.
  const { data: existing } = await supabase
    .from("partner_payout_accounts")
    .select("stripe_connect_account_id")
    .eq("partner_id", partner.id)
    .maybeSingle();

  const stripe = getStripe();
  let accountId: string;

  if (existing?.stripe_connect_account_id) {
    accountId = existing.stripe_connect_account_id as string;
  } else {
    // Standard Connect account. metadata.moonbeem_partner_id is the OWNER /
    // webhook-routing key; moonbeem_user_id is the acting-admin audit trail.
    const account = await stripe.accounts.create({
      type: "standard",
      email: user.email || undefined,
      metadata: {
        moonbeem_partner_id: partner.id,
        moonbeem_user_id: user.id,
      },
    });
    accountId = account.id;

    const { error: insErr } = await supabase
      .from("partner_payout_accounts")
      .insert({
        partner_id: partner.id,
        stripe_connect_account_id: accountId,
        onboarding_completed: false,
        payouts_enabled: false,
      });
    if (insErr) {
      // Race: a concurrent onboard beat us. Fetch the existing row and continue
      // with that account id rather than leaking an orphan Stripe account.
      const { data: refetch } = await supabase
        .from("partner_payout_accounts")
        .select("stripe_connect_account_id")
        .eq("partner_id", partner.id)
        .maybeSingle();
      if (refetch?.stripe_connect_account_id) {
        accountId = refetch.stripe_connect_account_id as string;
      } else {
        return NextResponse.json({ error: insErr.message }, { status: 500 });
      }
    }
  }

  const base = publicBaseUrl(request);
  const link = await stripe.accountLinks.create({
    account: accountId,
    refresh_url: `${base}/p/${slug}/dashboard?stripe_refresh=1`,
    return_url: `${base}/p/${slug}/dashboard?stripe_return=1`,
    type: "account_onboarding",
  });

  return NextResponse.json({
    onboarding_url: link.url,
    expires_at: link.expires_at,
  });
}
