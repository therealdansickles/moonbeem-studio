// POST /api/me/payouts/onboard
//
// Creates a Stripe Connect Standard account for the caller (or reuses
// the existing one if present), then returns a fresh Account Link
// the client uses to redirect the user into Stripe-hosted onboarding.
//
// Account Links are short-lived; the user might abandon and come back
// later — this endpoint is safe to call repeatedly to regenerate the
// link.

import { NextResponse, type NextRequest } from "next/server";
import { verifySession } from "@/lib/dal";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { getStripe } from "@/lib/stripe/server";

// Resolve the public base URL for Stripe-redirect targets. Stripe
// echoes return_url/refresh_url back verbatim, so a misconfigured
// env var in production lands users on localhost (verified incident
// 2026-05-08). Defensive: prefer NEXT_PUBLIC_SITE_URL when it isn't
// localhost; otherwise use the request's actual origin (what the
// user came in on) which is correct in both dev and prod.
function publicBaseUrl(request: NextRequest): string {
  const env = process.env.NEXT_PUBLIC_SITE_URL;
  if (env && !env.includes("localhost") && !env.includes("127.0.0.1")) {
    return env.replace(/\/$/, "");
  }
  return request.nextUrl.origin;
}

export async function POST(request: NextRequest) {
  const session = await verifySession();
  const supabase = createServiceRoleClient();

  const { data: creator, error: creatorErr } = await supabase
    .from("creators")
    .select("id")
    .eq("user_id", session.userId)
    .is("deleted_at", null)
    .maybeSingle();
  if (creatorErr) {
    return NextResponse.json({ error: creatorErr.message }, { status: 500 });
  }
  if (!creator) {
    return NextResponse.json({ error: "no_creator" }, { status: 409 });
  }

  // Reuse existing Connect account if one is already on file.
  const { data: existing } = await supabase
    .from("creator_payout_accounts")
    .select("stripe_connect_account_id")
    .eq("creator_id", creator.id)
    .maybeSingle();

  const stripe = getStripe();
  let accountId: string;

  if (existing?.stripe_connect_account_id) {
    accountId = existing.stripe_connect_account_id as string;
  } else {
    // Create a new Standard Connect account. We pass email so Stripe
    // pre-fills the onboarding form.
    const account = await stripe.accounts.create({
      type: "standard",
      email: session.email || undefined,
      metadata: {
        moonbeem_creator_id: creator.id,
        moonbeem_user_id: session.userId,
      },
    });
    accountId = account.id;

    const { error: insErr } = await supabase
      .from("creator_payout_accounts")
      .insert({
        creator_id: creator.id,
        stripe_connect_account_id: accountId,
        onboarding_completed: false,
        payouts_enabled: false,
      });
    if (insErr) {
      // Race: another concurrent onboard call beat us. Fetch the
      // existing row and continue with that account id rather than
      // leaking an orphan Stripe account.
      const { data: refetch } = await supabase
        .from("creator_payout_accounts")
        .select("stripe_connect_account_id")
        .eq("creator_id", creator.id)
        .maybeSingle();
      if (refetch?.stripe_connect_account_id) {
        accountId = refetch.stripe_connect_account_id as string;
      } else {
        return NextResponse.json(
          { error: insErr.message },
          { status: 500 },
        );
      }
    }
  }

  const base = publicBaseUrl(request);
  const link = await stripe.accountLinks.create({
    account: accountId,
    // Stripe redirects to refresh_url if the link expires before
    // completion, return_url after a successful onboarding submit.
    refresh_url: `${base}/me/edit?stripe_refresh=1`,
    return_url: `${base}/me?stripe_return=1`,
    type: "account_onboarding",
  });

  return NextResponse.json({
    onboarding_url: link.url,
    expires_at: link.expires_at,
  });
}
