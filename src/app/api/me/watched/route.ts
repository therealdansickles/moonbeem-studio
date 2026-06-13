// Native "watched" mark — Phase 2E.2. Mirrors /api/me/ratings verbatim:
//   - auth: getCurrentProfile (JSON 401, not a redirect)
//   - rate limit: userWrites
//   - capability: mark_watched (min tier signed_in, modeled on rate_title)
//   - creator resolve: the service-role idiom; creatorless → 400 no_creator
//   - visible-title gate (loadVisibleTitleById) on POST → 404 unknown_title
//   - markWatched / unmarkWatched helpers (insert-only / delete-idempotent)
// POST marks (watched:true), DELETE unmarks (watched:false).

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentProfile } from "@/lib/dal";
import { enforce } from "@/lib/ratelimit";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { getUserTier } from "@/lib/gating/get-user-tier";
import { canPerform } from "@/lib/gating/can-perform";
import { loadVisibleTitleById } from "@/lib/title-access";
import { markWatched, unmarkWatched } from "@/lib/watched/mark";

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

  const rl = await enforce("userWrites", userId, "me/watched");
  if (!rl.ok) return rl.response;

  const tier = await getUserTier(userId);
  const gate = canPerform(tier, "mark_watched", 0, isSuperAdmin);
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
  // Existence + visibility — same gate as /api/me/ratings: reject a title the
  // caller can't view (and soft-deleted titles). 404 unknown_title.
  const title = await loadVisibleTitleById(sb, titleId);
  if (!title) {
    return NextResponse.json({ error: "unknown_title" }, { status: 404 });
  }

  const result = await markWatched(creatorId, titleId);
  if (result) {
    return NextResponse.json({ error: result.error }, { status: 500 });
  }
  return NextResponse.json({ ok: true, watched: true });
}

export async function DELETE(request: NextRequest) {
  const profile = await getCurrentProfile();
  const userId = profile?.userId ?? null;
  const isSuperAdmin = profile?.role === "super_admin";
  if (!userId) {
    return NextResponse.json({ error: "auth_required" }, { status: 401 });
  }

  const rl = await enforce("userWrites", userId, "me/watched");
  if (!rl.ok) return rl.response;

  const tier = await getUserTier(userId);
  const gate = canPerform(tier, "mark_watched", 0, isSuperAdmin);
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

  // Explicit unmark deletes by (creator_id, title_id) regardless of source — an
  // imported row is removed too. Idempotent: 200 even if nothing was deleted.
  const result = await unmarkWatched(creatorId, titleId);
  if (result) {
    return NextResponse.json({ error: result.error }, { status: 500 });
  }
  return NextResponse.json({ ok: true, watched: false });
}
