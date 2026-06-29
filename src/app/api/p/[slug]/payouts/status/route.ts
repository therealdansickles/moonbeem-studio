// GET /api/p/[slug]/payouts/status
//
// Partner-side clone of the creator payout status read
// (src/app/api/me/payouts/status/route.ts). ACCOUNT STATE ONLY — no balances.
// The payable / held-settlement figures are B2; B1 reports only whether the
// partner has a Connect account and whether it's onboarded / payouts-enabled.
//
// Admin-gated read, same gate as the onboard route (super_admin OR
// partner_users role='admin').

import { NextResponse } from "next/server";
import { getCurrentProfile, getUser } from "@/lib/dal";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { enforce } from "@/lib/ratelimit";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const user = await getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const limit = await enforce("partnerWrites", user.id, "p/payouts/status");
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

  // super_admin bypasses partner_users; otherwise live partner_users admin only.
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

  const { data: acct } = await supabase
    .from("partner_payout_accounts")
    .select("onboarding_completed, payouts_enabled")
    .eq("partner_id", partner.id)
    .maybeSingle();

  // Account state only — no balances in B1.
  return NextResponse.json({
    has_account: !!acct,
    onboarding_completed: !!acct?.onboarding_completed,
    payouts_enabled: !!acct?.payouts_enabled,
  });
}
