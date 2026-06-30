// POST /api/titles/[id]/rent — start a Stripe Checkout to RENT or BUY a film.
// Body: { kind?: 'rental' | 'purchase' }, default 'rental'. kind selects the
// price column (transact_* vs purchase_*) and the entitlement kind the webhook
// grants. A bodyless POST is a rental (unchanged for the existing rent button).
//
// The FIRST money-IN viewer flow (transactions su2 rental + su4 purchase). Any
// AUTHENTICATED
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

  // kind: 'rental' (default — a bodyless POST stays a rental, unchanged for the
  // existing rent button) or 'purchase'. Validated against the two values.
  const body = (await request.json().catch(() => ({}))) as { kind?: unknown };
  let kind: "rental" | "purchase";
  if (body.kind === undefined || body.kind === "rental") {
    kind = "rental";
  } else if (body.kind === "purchase") {
    kind = "purchase";
  } else {
    return NextResponse.json({ error: "invalid_kind" }, { status: 400 });
  }

  const supabase = createServiceRoleClient();

  // Load the offer (both price pairs). Must be enabled with a positive integer
  // price for the requested kind.
  const { data: title } = await supabase
    .from("titles")
    .select(
      "id, slug, title, transact_enabled, transact_price_cents, purchase_enabled, purchase_price_cents",
    )
    .eq("id", id)
    .is("deleted_at", null) // never transact a soft-deleted offer
    .maybeSingle();
  if (!title) {
    return NextResponse.json({ error: "title_not_found" }, { status: 404 });
  }
  // Price + enable flag by kind: rental uses the transact_* pair, purchase the
  // purchase_* pair. Same integer / > 0 validation either way.
  const enabled =
    kind === "purchase" ? title.purchase_enabled : title.transact_enabled;
  const priceCents = (
    kind === "purchase"
      ? title.purchase_price_cents
      : title.transact_price_cents
  ) as number | null;
  if (
    enabled !== true ||
    typeof priceCents !== "number" ||
    !Number.isInteger(priceCents) ||
    priceCents <= 0
  ) {
    return NextResponse.json(
      { error: kind === "purchase" ? "not_purchasable" : "not_rentable" },
      { status: 400 },
    );
  }

  // PUBLISHED-FILM GATE (Fix 1): a title is sellable (rent OR purchase) ONLY once
  // it has at least one live, published Mux episode — otherwise the sale is
  // undeliverable (the buyer pays with nothing to watch). Runs AFTER the
  // kind-aware offer gate above, so this single check covers BOTH kinds. Mirrors
  // getTitleEpisodes' definition of "live" (is_published = true); reuses the
  // existing service-role client + the validated path id.
  const { data: publishedEpisodes } = await supabase
    .from("title_episodes")
    .select("id")
    .eq("title_id", id)
    .eq("is_published", true)
    .limit(1);
  if (!publishedEpisodes || publishedEpisodes.length === 0) {
    return NextResponse.json({ error: "not_yet_available" }, { status: 400 });
  }

  // KIND-AWARE DOUBLE-PAY GUARD.
  //  - purchase: block ONLY if the viewer already OWNS this title (an active
  //    purchase). A viewer mid-rental may still buy — the rent→buy upgrade.
  //  - rental: block if the viewer holds ANY active entitlement (rental OR
  //    purchase) — they already have access, don't charge again.
  const { data: existing } = await supabase
    .from("entitlements")
    .select("kind, purchased_at, first_played_at")
    .eq("user_id", user.id)
    .eq("title_id", id)
    .order("purchased_at", { ascending: false })
    .limit(5);
  const active = (existing ?? []).filter((e) =>
    isEntitlementActive({
      kind: e.kind as string,
      purchased_at: e.purchased_at as string,
      first_played_at: (e.first_played_at as string | null) ?? null,
    }),
  );
  const alreadyHas =
    kind === "purchase"
      ? active.some((e) => e.kind === "purchase") // already owns it permanently
      : active.length > 0; // already has access (active rental or purchase)
  if (alreadyHas) {
    return NextResponse.json({ already_entitled: true });
  }

  const stripe = getStripe();
  const baseUrl = publicBaseUrl(request);
  const slug = title.slug as string;
  const successUrl = `${baseUrl}/t/${slug}#watch`;
  const cancelUrl = `${baseUrl}/t/${slug}?${kind === "purchase" ? "purchase_cancelled" : "rent_cancelled"}=1`;

  // ATTRIBUTION CAPTURE (Stage 3, best-effort). Read the mb_aff cookie set by
  // /go/title on a profile Top-12 click; if it names a valid CLAIMED creator who
  // is NOT the buyer and the click is within the 7-day window, credit them. The
  // ENTIRE block is wrapped in try/catch: ANY failure (missing/garbage cookie,
  // JSON parse error, query error) leaves creatorId null and the sale proceeds
  // UNCHANGED. Attribution must never block or throw the rent/buy.
  let creatorId: string | null = null;
  try {
    const raw = request.cookies.get("mb_aff")?.value;
    if (raw) {
      const parsed = JSON.parse(raw) as {
        creator_id?: unknown;
        title_id?: unknown;
        ts?: unknown;
      };
      const cookieCreatorId =
        typeof parsed.creator_id === "string" ? parsed.creator_id : null;
      const ts = typeof parsed.ts === "number" ? parsed.ts : 0;
      // Window guard: 7 days (last-click recency). Scoping (ii): we do NOT
      // require parsed.title_id to match `id` — any title in the window credits
      // the curator (title_id is carried for a future scoping-(i) narrowing).
      const withinWindow = ts > 0 && Date.now() - ts <= 604800000;
      if (cookieCreatorId && UUID_RE.test(cookieCreatorId) && withinWindow) {
        // Valid CLAIMED creator AND not self-attribution, in one query.
        const { data: creator } = await supabase
          .from("creators")
          .select("user_id")
          .eq("id", cookieCreatorId)
          .eq("is_claimed", true)
          .not("user_id", "is", null)
          .is("deleted_at", null)
          .maybeSingle();
        if (creator && (creator.user_id as string) !== user.id) {
          creatorId = cookieCreatorId; // valid credit
        }
        // creator null (invalid/unclaimed) OR user_id === buyer (self) → null
      }
    }
  } catch {
    creatorId = null; // best-effort: any failure → unattributed, sale proceeds
  }

  // Metadata round-trips to the webhook (read off session OR payment_intent).
  // All values are strings (Stripe metadata is string→string); the webhook
  // re-parses moonbeem_price_cents to an integer and re-validates, and reads
  // moonbeem_kind to grant the matching entitlement kind. moonbeem_creator_id is
  // added ONLY when attribution resolved (omitted otherwise — webhook reads
  // ?? null).
  const metadata: Record<string, string> = {
    moonbeem_kind: kind,
    moonbeem_user_id: user.id,
    moonbeem_title_id: id,
    moonbeem_price_cents: String(priceCents),
  };
  if (creatorId) {
    metadata.moonbeem_creator_id = creatorId;
  }

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
              product_data: {
                name: `${kind === "purchase" ? "Purchase" : "Rental"}: ${title.title as string}`,
              },
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
      { idempotencyKey: `${kind === "purchase" ? "buy" : "rent"}-${user.id}-${id}-${priceCents}` },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "stripe_error";
    console.error(`[titles/${id}/rent] checkout.sessions.create failed: ${msg}`);
    return NextResponse.json({ error: "stripe_error" }, { status: 502 });
  }

  return NextResponse.json({ checkout_url: session.url });
}
