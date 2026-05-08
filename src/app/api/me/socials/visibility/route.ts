// PATCH /api/me/socials/visibility — toggle display_on_profile on a
// single (caller's creator, platform) row.
//
// Body shape: { platform: SocialPlatform, display_on_profile: boolean }.
// Returns the updated row. The caller's creator_id is derived from
// the session — clients can't write to other users' socials.
//
// Only verified rows are eligible: toggling visibility on an
// unverified social is rejected (the public profile only renders
// verified rows, so the toggle would be a no-op anyway and we don't
// want to confuse the UI).
//
// Reads/writes via service-role; creator_socials has RLS with no
// public SELECT/UPDATE policies. The auth check happens in code via
// verifySession + the creator_id scope on the UPDATE.

import { NextResponse, type NextRequest } from "next/server";
import { verifySession } from "@/lib/dal";
import { createServiceRoleClient } from "@/lib/supabase/service";
import {
  ALLOWED_SOCIAL_PLATFORMS,
  type SocialPlatform,
} from "@/lib/socials/handle";

type Body = {
  platform?: SocialPlatform;
  display_on_profile?: boolean;
};

export async function PATCH(request: NextRequest) {
  const session = await verifySession();

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  if (
    !body.platform ||
    !(ALLOWED_SOCIAL_PLATFORMS as readonly string[]).includes(body.platform)
  ) {
    return NextResponse.json({ error: "invalid_platform" }, { status: 400 });
  }
  if (typeof body.display_on_profile !== "boolean") {
    return NextResponse.json(
      { error: "display_on_profile_not_boolean" },
      { status: 400 },
    );
  }

  const supabase = createServiceRoleClient();
  const { data: creator } = await supabase
    .from("creators")
    .select("id")
    .eq("user_id", session.userId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!creator) {
    return NextResponse.json({ error: "no_creator" }, { status: 404 });
  }

  const { data: updated, error } = await supabase
    .from("creator_socials")
    .update({ display_on_profile: body.display_on_profile })
    .eq("creator_id", creator.id as string)
    .eq("platform", body.platform)
    .eq("is_verified", true)
    .select("platform, handle, display_on_profile, verified_at, is_verified")
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!updated) {
    return NextResponse.json(
      { error: "no_verified_social_for_platform" },
      { status: 404 },
    );
  }
  return NextResponse.json({ ok: true, social: updated });
}
