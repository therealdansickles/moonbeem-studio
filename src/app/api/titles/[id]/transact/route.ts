// PATCH /api/titles/[id]/transact — set a title's native RENTAL OFFER (price +
// enabled). Distributor-set, INTEGER CENTS, NO hard floor (any external
// iTunes/Amazon price is guidance only, surfaced in the UI, never enforced).
// Title-scoped (NOT /api/admin), so owning-partner-admins are authorized via the
// OR gate — mirrors PATCH /api/titles/[id]/territories exactly (getUser ->
// enforce("partnerWrites") -> UUID -> authorizeTitleMutation -> service-role
// update -> select-confirm -> revalidate). Body:
//   { transact_enabled: boolean, transact_price_cents: integer }
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

  let body: { transact_enabled?: unknown; transact_price_cents?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  if (typeof body.transact_enabled !== "boolean") {
    return NextResponse.json({ error: "invalid_enabled" }, { status: 400 });
  }
  const enabled = body.transact_enabled;

  // Price: a non-negative safe integer number of CENTS. Reject float / negative
  // / NaN / non-number outright — no rounding, no coercion.
  const price = body.transact_price_cents;
  if (
    typeof price !== "number" ||
    !Number.isInteger(price) ||
    price < 0 ||
    !Number.isSafeInteger(price)
  ) {
    return NextResponse.json({ error: "invalid_price" }, { status: 400 });
  }
  // Can't enable a free rental — an enabled offer must cost something.
  if (enabled && price <= 0) {
    return NextResponse.json(
      { error: "price_required_when_enabled" },
      { status: 400 },
    );
  }

  const supabase = createServiceRoleClient();

  const { data: updated, error } = await supabase
    .from("titles")
    .update({ transact_enabled: enabled, transact_price_cents: price })
    .eq("id", id)
    .select("id, slug, transact_enabled, transact_price_cents")
    .maybeSingle();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!updated) {
    return NextResponse.json({ error: "title_not_found" }, { status: 404 });
  }

  // PAID MARKER on the title's Mux film episode(s) — the COALESCE gating source
  // of truth. Inert today (nothing reads monetization_mode); coherent prep for
  // the sub-unit-3 playback gate. Best-effort: the price already saved above.
  const marker = enabled ? "transactional" : null;
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
    mux_episodes_marked: markErr ? null : (markedCount ?? 0),
  });
}
