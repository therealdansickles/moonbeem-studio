// Shared native-rating upsert + validator, used by BOTH the ratings route
// (/api/me/ratings) and the diary route (/api/me/diary, when a log/review
// carries a rating). title_ratings' unique is PARTIAL ((creator_id,title_id)
// WHERE title_id IS NOT NULL), which PostgREST .upsert(onConflict) cannot
// bind — so this is an explicit select-then-update-else-insert with a 23505
// race fallback that retries as an update. Extracted from the Phase 1A ratings
// route verbatim (behavior identical).

import { createServiceRoleClient } from "@/lib/supabase/service";

// Mirror the DB CHECK (numeric(2,1), 0.5–5.0, half-steps) so callers 400
// before the constraint can 23514.
export function isHalfStepRating(r: unknown): r is number {
  return (
    typeof r === "number" &&
    Number.isFinite(r) &&
    r >= 0.5 &&
    r <= 5.0 &&
    r * 2 === Math.floor(r * 2)
  );
}

// Upsert the caller's current native rating for a title. Returns null on
// success or { error } on a DB failure (the caller maps it to a 500).
export async function upsertTitleRating(params: {
  creatorId: string;
  titleId: string;
  rating: number;
}): Promise<{ error: string } | null> {
  const sb = createServiceRoleClient();
  const fields = {
    rating: params.rating,
    rated_on: new Date().toISOString().slice(0, 10), // YYYY-MM-DD (rated_on::date)
    source: "native",
    visibility: "public",
  } as const;

  const { data: existing } = await sb
    .from("title_ratings")
    .select("id")
    .eq("creator_id", params.creatorId)
    .eq("title_id", params.titleId)
    .maybeSingle();

  if (existing?.id) {
    const { error } = await sb
      .from("title_ratings")
      .update(fields)
      .eq("id", existing.id as string);
    return error ? { error: error.message } : null;
  }

  const { error } = await sb.from("title_ratings").insert({
    creator_id: params.creatorId,
    title_id: params.titleId,
    ...fields,
  });
  if (error) {
    if (error.code === "23505") {
      // Lost an insert race — the row exists now; switch to update.
      const { error: uErr } = await sb
        .from("title_ratings")
        .update(fields)
        .eq("creator_id", params.creatorId)
        .eq("title_id", params.titleId);
      return uErr ? { error: uErr.message } : null;
    }
    return { error: error.message };
  }
  return null;
}
