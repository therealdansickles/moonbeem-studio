// Native review write — Phase 1B. A review = a diary_entries row with a
// non-empty review_text. Mirrors /api/me/ratings in shape. When a review
// carries a rating, it also syncs the title_ratings "current rating" via the
// shared upsert (the aggregate trigger then updates titles.rating_avg/_count).

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentProfile } from "@/lib/dal";
import { enforce } from "@/lib/ratelimit";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { getUserTier } from "@/lib/gating/get-user-tier";
import { canPerform } from "@/lib/gating/can-perform";
import { isHalfStepRating, upsertTitleRating } from "@/lib/ratings/upsert";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_REVIEW_LEN = 10000;

// A date string (YYYY-MM-DD), valid, and not in the future (UTC date compare).
function isValidWatchedOn(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return false;
  const today = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  return d.getTime() <= today.getTime();
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

  const rl = await enforce("userWrites", userId, "me/reviews");
  if (!rl.ok) return rl.response;

  const tier = await getUserTier(userId);
  const gate = canPerform(tier, "write_review", 0, isSuperAdmin);
  if (!gate.allowed) {
    return NextResponse.json({ error: gate.reason }, { status: 403 });
  }

  let body: {
    title_id?: string;
    review_text?: string;
    rating?: number | null;
    watched_on?: string;
    contains_spoilers?: boolean;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const titleId = (body.title_id ?? "").trim();
  if (!UUID_RE.test(titleId)) {
    return NextResponse.json({ error: "invalid title_id" }, { status: 400 });
  }

  const reviewText =
    typeof body.review_text === "string" ? body.review_text.trim() : "";
  if (!reviewText) {
    return NextResponse.json({ error: "review_text required" }, { status: 400 });
  }
  if (reviewText.length > MAX_REVIEW_LEN) {
    return NextResponse.json(
      { error: `review_text too long (max ${MAX_REVIEW_LEN})` },
      { status: 400 },
    );
  }

  const hasRating = body.rating !== undefined && body.rating !== null;
  if (hasRating && !isHalfStepRating(body.rating)) {
    return NextResponse.json(
      { error: "invalid rating (0.5–5.0, half-steps)" },
      { status: 400 },
    );
  }
  const rating = hasRating ? (body.rating as number) : null;

  const watchedOn =
    typeof body.watched_on === "string" && body.watched_on !== ""
      ? body.watched_on
      : new Date().toISOString().slice(0, 10);
  if (!isValidWatchedOn(watchedOn)) {
    return NextResponse.json(
      { error: "invalid watched_on (date, not in the future)" },
      { status: 400 },
    );
  }

  const containsSpoilers = body.contains_spoilers === true;

  const creatorId = await resolveCreatorId(userId);
  if (!creatorId) {
    return NextResponse.json(
      { error: "no_creator — claim a Moonbeem handle first" },
      { status: 400 },
    );
  }

  const sb = createServiceRoleClient();
  const { data: title } = await sb
    .from("titles")
    .select("id")
    .eq("id", titleId)
    .maybeSingle();
  if (!title) {
    return NextResponse.json({ error: "unknown_title" }, { status: 404 });
  }

  // Sync the title_ratings current rating FIRST (idempotent upsert) when the
  // review carries one, so a rating-sync failure returns 500 BEFORE any review
  // row is committed — a client retry then can't duplicate the review
  // (diary_entries has no per-title uniqueness). Same upsert as /api/me/ratings;
  // the trigger recomputes the title aggregate.
  if (rating !== null) {
    const r = await upsertTitleRating({ creatorId, titleId, rating });
    if (r) return NextResponse.json({ error: r.error }, { status: 500 });
  }

  const { data: inserted, error } = await sb
    .from("diary_entries")
    .insert({
      creator_id: creatorId,
      title_id: titleId,
      watched_on: watchedOn,
      rating,
      review_text: reviewText,
      contains_spoilers: containsSpoilers,
      source: "native",
      visibility: "public",
      rewatch: false,
    })
    .select("id")
    .maybeSingle();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, id: inserted?.id ?? null });
}

export async function DELETE(request: NextRequest) {
  const profile = await getCurrentProfile();
  const userId = profile?.userId ?? null;
  const isSuperAdmin = profile?.role === "super_admin";
  if (!userId) {
    return NextResponse.json({ error: "auth_required" }, { status: 401 });
  }

  const rl = await enforce("userWrites", userId, "me/reviews");
  if (!rl.ok) return rl.response;

  const tier = await getUserTier(userId);
  const gate = canPerform(tier, "write_review", 0, isSuperAdmin);
  if (!gate.allowed) {
    return NextResponse.json({ error: gate.reason }, { status: 403 });
  }

  let body: { id?: string };
  try {
    body = (await request.json()) as { id?: string };
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const id = (body.id ?? "").trim();
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  const creatorId = await resolveCreatorId(userId);
  if (!creatorId) {
    return NextResponse.json(
      { error: "no_creator — claim a Moonbeem handle first" },
      { status: 400 },
    );
  }

  const sb = createServiceRoleClient();
  const { data: row } = await sb
    .from("diary_entries")
    .select("id, creator_id")
    .eq("id", id)
    .maybeSingle();
  if (!row) {
    return NextResponse.json({ ok: true }); // idempotent — already gone
  }
  if ((row.creator_id as string) !== creatorId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const { error } = await sb
    .from("diary_entries")
    .delete()
    .eq("id", id)
    .eq("creator_id", creatorId);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  // Ruling 2: deleting a review does NOT touch title_ratings.
  return NextResponse.json({ ok: true });
}
