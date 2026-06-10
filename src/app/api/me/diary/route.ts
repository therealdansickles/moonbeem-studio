// Unified diary write — Phase 1C. Supersedes /api/me/reviews. A diary entry is
// the general "I watched this" act; a review is just a diary entry that also
// carries review_text. Same gating/validation chain as the old reviews route,
// except review_text is OPTIONAL (when present: trimmed non-empty, ≤10000;
// when absent: contains_spoilers is forced false). rewatch defaults false.
// When a rating is present it syncs title_ratings via the shared upsert FIRST,
// so a sync failure returns 500 before the diary row is inserted (the rating
// change is user-intended). Note diary_entries has no per-title uniqueness, so
// a lost-response retry can still duplicate a successful log.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentProfile } from "@/lib/dal";
import { enforce } from "@/lib/ratelimit";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { getUserTier } from "@/lib/gating/get-user-tier";
import { canPerform } from "@/lib/gating/can-perform";
import { isHalfStepRating, upsertTitleRating } from "@/lib/ratings/upsert";
import { loadVisibleTitleById } from "@/lib/title-access";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_REVIEW_LEN = 10000;

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

  const rl = await enforce("userWrites", userId, "me/diary");
  if (!rl.ok) return rl.response;

  const tier = await getUserTier(userId);
  const gate = canPerform(tier, "log_diary", 0, isSuperAdmin);
  if (!gate.allowed) {
    return NextResponse.json({ error: gate.reason }, { status: 403 });
  }

  let body: {
    title_id?: string;
    rating?: number | null;
    watched_on?: string;
    review_text?: string | null;
    contains_spoilers?: boolean;
    rewatch?: boolean;
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

  // review_text is OPTIONAL. Present-and-non-empty → stored; absent/empty → null.
  if (body.review_text != null && typeof body.review_text !== "string") {
    return NextResponse.json({ error: "invalid review_text" }, { status: 400 });
  }
  const trimmedText =
    typeof body.review_text === "string" ? body.review_text.trim() : "";
  const reviewText = trimmedText.length > 0 ? trimmedText : null;
  if (reviewText && reviewText.length > MAX_REVIEW_LEN) {
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

  // Spoiler flag only means something with a review body; force false otherwise.
  const containsSpoilers = reviewText ? body.contains_spoilers === true : false;
  const rewatch = body.rewatch === true;

  const creatorId = await resolveCreatorId(userId);
  if (!creatorId) {
    return NextResponse.json(
      { error: "no_creator — claim a Moonbeem handle first" },
      { status: 400 },
    );
  }

  const sb = createServiceRoleClient();
  // Existence + visibility: reject a title the caller can't view, so a hidden/
  // embargoed title can't be surfaced on their public diary. Also rejects
  // soft-deleted titles.
  const title = await loadVisibleTitleById(sb, titleId);
  if (!title) {
    return NextResponse.json({ error: "unknown_title" }, { status: 404 });
  }

  // Rating sync FIRST (idempotent) — a sync failure aborts before the insert.
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
      rewatch,
      source: "native",
      visibility: "public",
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

  const rl = await enforce("userWrites", userId, "me/diary");
  if (!rl.ok) return rl.response;

  const tier = await getUserTier(userId);
  const gate = canPerform(tier, "log_diary", 0, isSuperAdmin);
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
  // Ruling 2 (1B): deleting a diary entry does NOT touch title_ratings.
  return NextResponse.json({ ok: true });
}
