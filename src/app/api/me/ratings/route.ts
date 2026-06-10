// Native title rating write — Phase 1A. Mirrors the shape of
// /api/me/fan-edits/single but for the title_ratings surface:
//   - auth: getCurrentProfile (JSON 401, not a redirect)
//   - rate limit: userWrites (30/min/user)
//   - capability: rate_title (min tier signed_in)
//   - creator resolve: the service-role idiom (creators has no anon SELECT);
//     creatorless users get 400 no_creator (they must claim a handle first)
//   - native writes always source='native', visibility='public'
//
// The title_ratings upsert + half-step validator live in @/lib/ratings/upsert
// (shared with /api/me/reviews); the partial unique (creator_id, title_id)
// can't bind PostgREST onConflict, so the helper does select-then-update-else-
// insert with a 23505 race fallback.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentProfile } from "@/lib/dal";
import { enforce } from "@/lib/ratelimit";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { getUserTier } from "@/lib/gating/get-user-tier";
import { canPerform } from "@/lib/gating/can-perform";
import { isHalfStepRating, upsertTitleRating } from "@/lib/ratings/upsert";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function resolveCreatorId(userId: string): Promise<string | null> {
  const sb = createServiceRoleClient();
  const { data } = await sb
    .from("creators")
    .select("id")
    .eq("user_id", userId)
    .is("deleted_at", null)
    .maybeSingle();
  return (data?.id as string | undefined) ?? null;
}

export async function POST(request: NextRequest) {
  const profile = await getCurrentProfile();
  const userId = profile?.userId ?? null;
  const isSuperAdmin = profile?.role === "super_admin";
  if (!userId) {
    return NextResponse.json({ error: "auth_required" }, { status: 401 });
  }

  const rl = await enforce("userWrites", userId, "me/ratings");
  if (!rl.ok) return rl.response;

  const tier = await getUserTier(userId);
  const gate = canPerform(tier, "rate_title", 0, isSuperAdmin);
  if (!gate.allowed) {
    return NextResponse.json({ error: gate.reason }, { status: 403 });
  }

  let body: { title_id?: string; rating?: number };
  try {
    body = (await request.json()) as { title_id?: string; rating?: number };
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const titleId = (body.title_id ?? "").trim();
  if (!UUID_RE.test(titleId)) {
    return NextResponse.json({ error: "invalid title_id" }, { status: 400 });
  }
  if (!isHalfStepRating(body.rating)) {
    return NextResponse.json(
      { error: "invalid rating (0.5–5.0, half-steps)" },
      { status: 400 },
    );
  }
  const rating = body.rating as number;

  const creatorId = await resolveCreatorId(userId);
  if (!creatorId) {
    return NextResponse.json(
      { error: "no_creator — claim a Moonbeem handle first" },
      { status: 400 },
    );
  }

  const sb = createServiceRoleClient();

  // Verify the title exists.
  const { data: title } = await sb
    .from("titles")
    .select("id")
    .eq("id", titleId)
    .maybeSingle();
  if (!title) {
    return NextResponse.json({ error: "unknown_title" }, { status: 404 });
  }

  const result = await upsertTitleRating({ creatorId, titleId, rating });
  if (result) {
    return NextResponse.json({ error: result.error }, { status: 500 });
  }
  return NextResponse.json({ ok: true, rating });
}

export async function DELETE(request: NextRequest) {
  const profile = await getCurrentProfile();
  const userId = profile?.userId ?? null;
  const isSuperAdmin = profile?.role === "super_admin";
  if (!userId) {
    return NextResponse.json({ error: "auth_required" }, { status: 401 });
  }

  const rl = await enforce("userWrites", userId, "me/ratings");
  if (!rl.ok) return rl.response;

  const tier = await getUserTier(userId);
  const gate = canPerform(tier, "rate_title", 0, isSuperAdmin);
  if (!gate.allowed) {
    return NextResponse.json({ error: gate.reason }, { status: 403 });
  }

  let body: { title_id?: string };
  try {
    body = (await request.json()) as { title_id?: string };
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const titleId = (body.title_id ?? "").trim();
  if (!UUID_RE.test(titleId)) {
    return NextResponse.json({ error: "invalid title_id" }, { status: 400 });
  }

  const creatorId = await resolveCreatorId(userId);
  if (!creatorId) {
    return NextResponse.json(
      { error: "no_creator — claim a Moonbeem handle first" },
      { status: 400 },
    );
  }

  const sb = createServiceRoleClient();
  const { error } = await sb
    .from("title_ratings")
    .delete()
    .eq("creator_id", creatorId)
    .eq("title_id", titleId);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  // Idempotent: 200 even if nothing was deleted.
  return NextResponse.json({ ok: true });
}
