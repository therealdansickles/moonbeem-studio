// Phase 2E.2 — native "watched" mark/unmark helpers. Shared by the title-page
// toggle route and the rating/diary auto-mark.
//
// Native paths are INSERT-ONLY: marking never updates an existing row's source
// or marked_on — an imported row stays imported. markWatched is a select-then-
// insert because the (creator_id, title_id) partial unique can't bind a
// PostgREST onConflict (the 1A lesson); a 23505 race just reads as already
// marked. unmarkWatched deletes by (creator_id, title_id) regardless of source
// (an explicit unmark removes an imported row too) and is idempotent.

import { createServiceRoleClient } from "@/lib/supabase/service";

export async function markWatched(
  creatorId: string,
  titleId: string,
): Promise<{ error: string } | null> {
  const sb = createServiceRoleClient();
  // Insert-only: if a row already exists (native OR imported), leave it
  // untouched. .limit(1) (not maybeSingle) stays dup-tolerant.
  const { data: existing } = await sb
    .from("watched_titles")
    .select("id")
    .eq("creator_id", creatorId)
    .eq("title_id", titleId)
    .limit(1);
  if (existing && existing.length > 0) return null;

  const { error } = await sb.from("watched_titles").insert({
    creator_id: creatorId,
    title_id: titleId,
    source: "native",
    visibility: "public",
    marked_on: new Date().toISOString().slice(0, 10), // current_date (UTC)
  });
  // A concurrent insert won the (creator_id, title_id) partial unique race →
  // 23505 → already marked, treat as success.
  if (error && error.code !== "23505") return { error: error.message };
  return null;
}

export async function unmarkWatched(
  creatorId: string,
  titleId: string,
): Promise<{ error: string } | null> {
  const sb = createServiceRoleClient();
  const { error } = await sb
    .from("watched_titles")
    .delete()
    .eq("creator_id", creatorId)
    .eq("title_id", titleId);
  if (error) return { error: error.message };
  return null;
}
