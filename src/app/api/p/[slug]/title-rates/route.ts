// Partner-admin endpoint for setting per-title CPM rates.
//
// PUT /api/p/[slug]/title-rates
// Body: { title_id, rate_cents_per_thousand }
// Auth: caller must be in partner_users with role='admin' for this
// partner. Viewer role cannot edit.
//
// Idempotent upsert into partner_title_rates on the unique
// (partner_id, title_id) where deleted_at is null. To pause a
// campaign, set rate_cents_per_thousand to 0 (still active);
// soft-deleting is a v2 concern.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentProfile, getUser } from "@/lib/dal";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { calculateEarningsForRate } from "@/lib/earnings-calc";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const user = await getUser();
  if (!user) {
    return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  }
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

  // super_admin bypasses partner_users check (matches /p/[slug]
  // page-level access). Otherwise the caller must be a partner_users
  // member with role='admin'.
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

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const titleId = (body as Record<string, unknown>)?.title_id;
  const rateRaw = (body as Record<string, unknown>)?.rate_cents_per_thousand;
  if (typeof titleId !== "string" || !UUID_RE.test(titleId)) {
    return NextResponse.json({ error: "invalid_title_id" }, { status: 400 });
  }
  const rate = typeof rateRaw === "number" ? Math.round(rateRaw) : NaN;
  if (!Number.isFinite(rate) || rate < 0) {
    return NextResponse.json({ error: "invalid_rate" }, { status: 400 });
  }

  // Verify the title actually belongs to this partner.
  const { data: title } = await supabase
    .from("titles")
    .select("id, partner_id")
    .eq("id", titleId)
    .maybeSingle();
  if (!title || title.partner_id !== partner.id) {
    return NextResponse.json({ error: "title_not_in_partner" }, {
      status: 400,
    });
  }

  // Partial unique index (partner_id, title_id) WHERE deleted_at IS
  // NULL doesn't compose with PostgREST onConflict, so do SELECT-
  // then-UPDATE/INSERT. Race risk on concurrent PUTs is acceptable
  // (loser hits the unique violation and retries).
  const { data: existing, error: selErr } = await supabase
    .from("partner_title_rates")
    .select("id")
    .eq("partner_id", partner.id)
    .eq("title_id", titleId)
    .is("deleted_at", null)
    .maybeSingle();
  if (selErr) {
    return NextResponse.json({ error: selErr.message }, { status: 500 });
  }

  if (existing) {
    const { error } = await supabase
      .from("partner_title_rates")
      .update({
        rate_cents_per_thousand: rate,
        updated_at: new Date().toISOString(),
      })
      .eq("id", existing.id);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
  } else {
    const { error } = await supabase
      .from("partner_title_rates")
      .insert({
        partner_id: partner.id,
        title_id: titleId,
        rate_cents_per_thousand: rate,
      });
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
  }

  // Auto-recalc earnings for this (partner, title) scope so the
  // partner sees the new rate reflected in the dashboard's
  // "calculated this month" tile without a separate ops trigger.
  // Idempotent on the (creator, edit, day) unique index — re-running
  // overwrites today's row rather than double-paying.
  const today = new Date().toISOString().slice(0, 10);
  const recalc = await calculateEarningsForRate(
    supabase,
    {
      partner_id: partner.id,
      title_id: titleId,
      rate_cents_per_thousand: rate,
    },
    today,
  );

  return NextResponse.json({
    ok: true,
    partner_id: partner.id,
    title_id: titleId,
    rate_cents_per_thousand: rate,
    recalc: {
      rows_upserted: recalc.rows_upserted,
      total_earnings_cents: recalc.total_earnings_cents,
      error: recalc.error ?? null,
    },
  });
}
