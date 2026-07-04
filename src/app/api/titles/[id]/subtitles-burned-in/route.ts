// PATCH /api/titles/[id]/subtitles-burned-in  — set the burned-in marker (per title).
//
// Body { burned_in: boolean }. authorizeTitleMutation gate. This is the admin-visible
// signal that a title's subtitles are baked into the video frames, so a missing CC
// menu is never ambiguous. Title-level today (1-asset films); see the migration for
// the episode-level graduation path.

import { NextResponse, type NextRequest } from "next/server";
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
  if (!user) return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  const rl = await enforce("partnerWrites", user.id, "titles/subtitles-burned-in");
  if (!rl.ok) return rl.response;

  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const authz = await authorizeTitleMutation(user.id, id);
  if (!authz.ok) {
    const status =
      authz.reason === "not_authenticated" ? 401 : authz.reason === "title_not_found" ? 404 : 403;
    return NextResponse.json({ error: authz.reason }, { status });
  }

  let body: { burned_in?: unknown } = {};
  try {
    body = (await request.json()) as { burned_in?: unknown };
  } catch {
    // fall through
  }
  if (typeof body.burned_in !== "boolean") {
    return NextResponse.json({ error: "burned_in_boolean_required" }, { status: 400 });
  }

  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from("titles")
    .update({ subtitles_burned_in: body.burned_in })
    .eq("id", id)
    .select("id, subtitles_burned_in")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ title: data });
}
