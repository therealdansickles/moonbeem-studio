// POST /api/creators/[id]/tip — start a Stripe Checkout for a fan to TIP a
// creator. Body: { amount_cents: number, message?: string, return_path?: string }.
//
// v1 REQUIRES AUTH (the payer is the logged-in user; tips.payer_user_id is
// nullable only to future-proof guest tips). Clones the rental Checkout shape
// (mode:'payment', integer-cents unit_amount, metadata on BOTH session +
// payment_intent_data), charges the fan as a guest (customer_email). A PENDING
// tips row is created FIRST so tip_id can ride in the metadata; the webhook's
// grant_tip marks it paid + writes the settlement (creator owed 100%, Stripe fee
// absorbed). Returns { checkout_url }.
//
// FEE: zero platform fee — the creator receives 100% of the gross tip and
// Moonbeem absorbs Stripe's processing fee (deliberate positioning). Integer
// cents only; no float reaches Stripe or the DB.

import { NextResponse, type NextRequest } from "next/server";
import { getUser } from "@/lib/dal";
import { enforce } from "@/lib/ratelimit";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { getStripe } from "@/lib/stripe/server";
import { safeInternalRedirect } from "@/lib/auth/redirect";
import {
  validateTipAmountCents,
  MIN_TIP_CENTS,
  MAX_TIP_CENTS,
} from "@/lib/tips/amount";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_MESSAGE_LEN = 280;

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
  const user = await getUser();
  if (!user) {
    return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  }
  const rl = await enforce("standardAnon", user.id, "creators/tip");
  if (!rl.ok) return rl.response;

  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "creator_not_found" }, { status: 404 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    amount_cents?: unknown;
    message?: unknown;
    return_path?: unknown;
  };

  // Server-authoritative amount validation (floor $2 / ceiling $500, integer cents).
  const amt = validateTipAmountCents(body.amount_cents);
  if (!amt.ok) {
    return NextResponse.json(
      { error: amt.error, minimum_cents: MIN_TIP_CENTS, maximum_cents: MAX_TIP_CENTS },
      { status: 400 },
    );
  }

  let message: string | null = null;
  if (body.message != null) {
    if (typeof body.message !== "string") {
      return NextResponse.json({ error: "invalid_message" }, { status: 400 });
    }
    const trimmed = body.message.trim();
    if (trimmed.length > MAX_MESSAGE_LEN) {
      return NextResponse.json(
        { error: "message_too_long", max: MAX_MESSAGE_LEN },
        { status: 400 },
      );
    }
    message = trimmed.length ? trimmed : null;
  }

  const supabase = createServiceRoleClient();

  // The tippee must be a CLAIMED creator (a real user who can eventually
  // withdraw) and not the payer themselves.
  const { data: creator } = await supabase
    .from("creators")
    .select("id, user_id, is_claimed, deleted_at, display_name")
    .eq("id", id)
    .maybeSingle();
  if (
    !creator ||
    creator.deleted_at != null ||
    creator.is_claimed !== true ||
    creator.user_id == null
  ) {
    return NextResponse.json({ error: "creator_not_tippable" }, { status: 404 });
  }
  if ((creator.user_id as string) === user.id) {
    return NextResponse.json({ error: "cannot_tip_self" }, { status: 400 });
  }

  // Create the PENDING tip first so tip_id can ride in the Checkout metadata.
  const { data: tip, error: tipErr } = await supabase
    .from("tips")
    .insert({
      creator_id: id,
      payer_user_id: user.id,
      tipper_email: user.email ?? null,
      amount_cents: amt.cents,
      message,
      status: "pending",
    })
    .select("id")
    .single();
  if (tipErr || !tip) {
    console.error(`[creators/${id}/tip] tip insert failed: ${tipErr?.message}`);
    return NextResponse.json({ error: "tip_create_failed" }, { status: 500 });
  }

  const displayName =
    (creator.display_name as string | null)?.trim() || "a Moonbeem creator";
  const base = publicBaseUrl(request);
  const safePath = safeInternalRedirect(
    typeof body.return_path === "string" ? body.return_path : null,
  ) ?? "/";
  const successUrl = new URL(safePath, base);
  successUrl.searchParams.set("tip", "success");
  const cancelUrl = new URL(safePath, base);
  cancelUrl.searchParams.set("tip", "cancelled");

  const metadata: Record<string, string> = {
    moonbeem_kind: "tip",
    moonbeem_tip_id: tip.id as string,
    moonbeem_creator_id: id,
    moonbeem_payer_user_id: user.id,
    moonbeem_amount_cents: String(amt.cents),
  };

  const stripe = getStripe();
  let session;
  try {
    session = await stripe.checkout.sessions.create(
      {
        mode: "payment",
        customer_email: user.email ?? undefined,
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: "usd",
              unit_amount: amt.cents,
              product_data: { name: `Tip for ${displayName}` },
            },
          },
        ],
        success_url: successUrl.toString(),
        cancel_url: cancelUrl.toString(),
        metadata,
        payment_intent_data: { metadata },
      },
      // Stable per tip row: a retry of THIS tip returns the same session.
      { idempotencyKey: `tip-${tip.id as string}` },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "stripe_error";
    console.error(`[creators/${id}/tip] checkout.sessions.create failed: ${msg}`);
    // Clean up the orphan pending tip — no charge happened. (An ABANDONED
    // checkout — session created but never completed — still leaves a pending
    // row; a periodic sweep is a filed follow-up.)
    await supabase
      .from("tips")
      .delete()
      .eq("id", tip.id as string)
      .eq("status", "pending");
    return NextResponse.json({ error: "stripe_error" }, { status: 502 });
  }

  return NextResponse.json({ checkout_url: session.url });
}
