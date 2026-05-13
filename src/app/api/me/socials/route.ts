// Returns the signed-in user's creator_socials rows: verified,
// pending (with code), or unverified placeholders.
//
// Reads via the service-role client because creator_socials has
// RLS enabled with no SELECT policies (matching the convention
// used by external_clicks/tips). Scoped to creator_id = caller's
// creator, so this can't leak other users' data.

import { NextResponse } from "next/server";
import { verifySession } from "@/lib/dal";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { enforce } from "@/lib/ratelimit";

export async function GET() {
  const session = await verifySession();
  const limit = await enforce("userWrites", session.userId, "me/socials");
  if (!limit.ok) return limit.response;

  const supabase = createServiceRoleClient();

  const { data: creator, error: creatorErr } = await supabase
    .from("creators")
    .select("id, moonbeem_handle")
    .eq("user_id", session.userId)
    .is("deleted_at", null)
    .maybeSingle();
  if (creatorErr) {
    return NextResponse.json({ error: creatorErr.message }, { status: 500 });
  }
  if (!creator) {
    return NextResponse.json({
      creator_id: null,
      moonbeem_handle: null,
      socials: [],
    });
  }

  const { data: socials, error: socialsErr } = await supabase
    .from("creator_socials")
    .select(
      "platform, handle, verified_at, is_verified, verification_code, verification_started_at, verification_method, display_on_profile",
    )
    .eq("creator_id", creator.id);
  if (socialsErr) {
    return NextResponse.json({ error: socialsErr.message }, { status: 500 });
  }

  return NextResponse.json({
    creator_id: creator.id,
    moonbeem_handle: creator.moonbeem_handle,
    socials: socials ?? [],
  });
}
