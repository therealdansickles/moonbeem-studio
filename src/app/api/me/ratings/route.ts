// Native title rating write — Phase 1A. Mirrors the shape of
// /api/me/fan-edits/single but for the title_ratings surface:
//   - auth: getCurrentProfile (JSON 401, not a redirect)
//   - rate limit: userWrites (30/min/user)
//   - capability: rate_title (min tier signed_in)
//   - creator resolve: the service-role idiom (creators has no anon SELECT);
//     creatorless users get 400 no_creator (they must claim a handle first)
//   - native writes always source='native', visibility='public'
//
// title_ratings' unique is PARTIAL ((creator_id, title_id) WHERE title_id IS
// NOT NULL), which PostgREST .upsert(onConflict) cannot bind — so the write is
// an explicit select-then-update-else-insert, with a 23505 fallback that
// retries as an update (lost insert race).

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentProfile } from "@/lib/dal";
import { enforce } from "@/lib/ratelimit";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { getUserTier } from "@/lib/gating/get-user-tier";
import { canPerform } from "@/lib/gating/can-perform";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Mirror the DB CHECK (numeric(2,1), 0.5–5.0, half-steps) so we 400 before
// the constraint can 23514.
function isValidRating(r: unknown): r is number {
  return (
    typeof r === "number" &&
    Number.isFinite(r) &&
    r >= 0.5 &&
    r <= 5.0 &&
    r * 2 === Math.floor(r * 2)
  );
}

function today(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (rated_on::date)
}

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
  if (!isValidRating(body.rating)) {
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

  const fields = {
    rating,
    rated_on: today(),
    source: "native",
    visibility: "public",
  } as const;

  const { data: existing } = await sb
    .from("title_ratings")
    .select("id")
    .eq("creator_id", creatorId)
    .eq("title_id", titleId)
    .maybeSingle();

  if (existing?.id) {
    const { error } = await sb
      .from("title_ratings")
      .update(fields)
      .eq("id", existing.id as string);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ ok: true, rating });
  }

  const { error } = await sb.from("title_ratings").insert({
    creator_id: creatorId,
    title_id: titleId,
    ...fields,
  });
  if (error) {
    if (error.code === "23505") {
      // Lost an insert race — the row exists now; switch to update.
      const { error: uErr } = await sb
        .from("title_ratings")
        .update(fields)
        .eq("creator_id", creatorId)
        .eq("title_id", titleId);
      if (uErr) {
        return NextResponse.json({ error: uErr.message }, { status: 500 });
      }
      return NextResponse.json({ ok: true, rating });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
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
