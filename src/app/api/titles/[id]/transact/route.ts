// PATCH /api/titles/[id]/transact — set a title's native RENTAL and/or PURCHASE
// OFFER (price + enabled, per kind). Distributor-set, INTEGER CENTS, NO hard
// floor (any external
// iTunes/Amazon price is guidance only, surfaced in the UI, never enforced).
// Title-scoped (NOT /api/admin), so owning-partner-admins are authorized via the
// OR gate — mirrors PATCH /api/titles/[id]/territories exactly (getUser ->
// enforce("partnerWrites") -> UUID -> authorizeTitleMutation -> service-role
// update -> select-confirm -> revalidate). Body (send either or both pairs):
//   { transact_enabled?: boolean, transact_price_cents?: integer,
//     purchase_enabled?: boolean, purchase_price_cents?: integer }
// The episode 'transactional' marker is set when EITHER offer is enabled, and
// cleared only when BOTH are disabled (the gate is kind-agnostic).
//
// VALIDATION: transact_price_cents must be a non-negative SAFE INTEGER (cents);
// enabling (transact_enabled=true) requires transact_price_cents > 0 (can't
// enable a $0 rental). No float is ever stored — the UI parses dollars -> cents.
//
// PAID MARKER (the scope decision): the OFFER (price + enabled) lives on the
// TITLE; the gating MARKER lives on the title's Mux FILM episode. Per the U1
// resolution rule (effective = COALESCE(title_episodes.monetization_mode,
// titles.default_monetization_mode); the asset override is the gating source of
// truth), enabling stamps monetization_mode='transactional' on the title's Mux
// episode(s) and disabling clears it back to NULL (inherits the title default
// 'free'). This is ONLY the marker — there is NO gate / charge / entitlement
// here, and nothing reads monetization_mode yet (sub-unit 3 does), so stamping
// is behaviorally inert today and just keeps the data coherent. A title with no
// Mux episode marks 0 rows (the offer can still be set; it has nothing to rent
// until a film is uploaded). The marker write is best-effort: the price is the
// user-facing outcome, so a marker hiccup logs + reports a flag rather than
// failing the (already-saved) price.

import { NextResponse, type NextRequest } from "next/server";
import { revalidatePath } from "next/cache";
import { getUser } from "@/lib/dal";
import { enforce } from "@/lib/ratelimit";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { authorizeTitleMutation } from "@/lib/auth/title-mutation";
import { validateCreatorSharePct } from "@/lib/affiliate/rate";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getUser();
  if (!user) {
    return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  }
  const rl = await enforce("partnerWrites", user.id, "titles/transact");
  if (!rl.ok) return rl.response;

  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "title_not_found" }, { status: 404 });
  }

  const authz = await authorizeTitleMutation(user.id, id);
  if (!authz.ok) {
    const status =
      authz.reason === "not_authenticated"
        ? 401
        : authz.reason === "title_not_found"
          ? 404
          : 403;
    return NextResponse.json({ error: authz.reason }, { status });
  }

  let body: {
    transact_enabled?: unknown;
    transact_price_cents?: unknown;
    purchase_enabled?: unknown;
    purchase_price_cents?: unknown;
    creator_share_pct?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  // Validate ONE offer pair (enabled + price): enabled is boolean, price is a
  // non-negative SAFE INTEGER of cents (reject float / negative / NaN / non-
  // number — no rounding, no coercion), and you can't enable a $0 offer.
  function validatePair(
    enabledVal: unknown,
    priceVal: unknown,
  ):
    | { ok: true; enabled: boolean; price: number }
    | { ok: false; error: string } {
    if (typeof enabledVal !== "boolean") {
      return { ok: false, error: "invalid_enabled" };
    }
    if (
      typeof priceVal !== "number" ||
      !Number.isInteger(priceVal) ||
      priceVal < 0 ||
      !Number.isSafeInteger(priceVal)
    ) {
      return { ok: false, error: "invalid_price" };
    }
    if (enabledVal && priceVal <= 0) {
      return { ok: false, error: "price_required_when_enabled" };
    }
    return { ok: true, enabled: enabledVal, price: priceVal };
  }

  // Update whichever offer pair(s) the caller sent. The Rental card sends the
  // transact_* pair, the Purchase card the purchase_* pair; both may be present.
  const update: {
    transact_enabled?: boolean;
    transact_price_cents?: number;
    purchase_enabled?: boolean;
    purchase_price_cents?: number;
    creator_share_pct?: number | null;
  } = {};
  if (body.transact_enabled !== undefined) {
    const r = validatePair(body.transact_enabled, body.transact_price_cents);
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
    update.transact_enabled = r.enabled;
    update.transact_price_cents = r.price;
  }
  if (body.purchase_enabled !== undefined) {
    const r = validatePair(body.purchase_enabled, body.purchase_price_cents);
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
    update.purchase_enabled = r.enabled;
    update.purchase_price_cents = r.price;
  }
  // AFFILIATE RATE (Stage C) — titles.creator_share_pct (a FRACTION, or null to
  // disable). SERVER-AUTHORITATIVE exact-bps validation via the SHARED validator
  // the card mirrors: a rate that doesn't map to exact bps would make the settle
  // pass silently REFUSE every rental of this title, so reject it here
  // (invalid_affiliate_rate) rather than persist a settlement-breaking value.
  // Rides the SAME authorizeTitleMutation gate above — no new ownership path.
  if (body.creator_share_pct !== undefined) {
    const v = validateCreatorSharePct(body.creator_share_pct);
    if (!v.ok) {
      return NextResponse.json(
        { error: "invalid_affiliate_rate" },
        { status: 400 },
      );
    }
    update.creator_share_pct = v.value;
  }
  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "no_offer_fields" }, { status: 400 });
  }

  const supabase = createServiceRoleClient();

  const { data: updated, error } = await supabase
    .from("titles")
    .update(update)
    .eq("id", id)
    .select(
      "id, slug, transact_enabled, transact_price_cents, purchase_enabled, purchase_price_cents",
    )
    .maybeSingle();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!updated) {
    return NextResponse.json({ error: "title_not_found" }, { status: 404 });
  }

  // PAID MARKER on the title's Mux film episode(s) — the COALESCE gating source
  // of truth (the gate is kind-agnostic: 'transactional' just means "requires
  // payment", satisfied by an active rental OR purchase). Set when EITHER offer
  // is enabled; cleared to NULL only when BOTH are disabled. Computed from the
  // RETURNING row, so it's correct even when only one pair was sent. Best-effort:
  // the prices already saved above.
  const anyEnabled =
    updated.transact_enabled === true || updated.purchase_enabled === true;
  const marker = anyEnabled ? "transactional" : null;
  const { error: markErr, count: markedCount } = await supabase
    .from("title_episodes")
    .update({ monetization_mode: marker }, { count: "exact" })
    .eq("title_id", id)
    .eq("source", "mux");
  if (markErr) {
    console.error(
      `[titles/${id}/transact] monetization_mode marker write failed: ${markErr.message}`,
    );
  }

  revalidatePath(`/t/${updated.slug as string}`);

  return NextResponse.json({
    ok: true,
    titleId: updated.id,
    transact_enabled: updated.transact_enabled,
    transact_price_cents: updated.transact_price_cents,
    purchase_enabled: updated.purchase_enabled,
    purchase_price_cents: updated.purchase_price_cents,
    mux_episodes_marked: markErr ? null : (markedCount ?? 0),
  });
}
