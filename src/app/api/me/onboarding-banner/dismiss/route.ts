// POST /api/me/onboarding-banner/dismiss — hide the /me welcome banner.
//
// Called when the user explicitly closes the banner (× button) OR
// takes a first onboarding action through it (clicks "Pick films" or
// "Verify a handle"). Sets users.onboarding_banner_dismissed_at to
// now() if it's still null; a re-call on an already-dismissed banner
// is a harmless no-op.
//
// Service-role client scoped to session.userId — a user updating
// their own row, no RLS dependency.

import { NextResponse } from "next/server";
import { verifySession } from "@/lib/dal";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { enforce } from "@/lib/ratelimit";

export async function POST() {
  const session = await verifySession();
  const limit = await enforce(
    "userWrites",
    session.userId,
    "me/onboarding-banner/dismiss",
  );
  if (!limit.ok) return limit.response;

  const supabase = createServiceRoleClient();
  const { error } = await supabase
    .from("users")
    .update({ onboarding_banner_dismissed_at: new Date().toISOString() })
    .eq("id", session.userId)
    .is("onboarding_banner_dismissed_at", null);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
