// Phase 1D — shared server helpers for the lists / watchlist write routes.
// All writes go through the service-role client; ownership is enforced by the
// route (resolve the caller's creator, then scope every query to it).

import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getCurrentProfile } from "@/lib/dal";
import { enforce } from "@/lib/ratelimit";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { getUserTier } from "@/lib/gating/get-user-tier";
import { canPerform } from "@/lib/gating/can-perform";

export async function resolveCreatorId(userId: string): Promise<string | null> {
  const sb = createServiceRoleClient();
  const { data } = await sb
    .from("creators")
    .select("id")
    .eq("user_id", userId)
    .is("deleted_at", null)
    .maybeSingle();
  return (data?.id as string | undefined) ?? null;
}

// Shared gating chain for every lists endpoint (identical posture to
// /api/me/diary): JSON 401 for anon, userWrites rate limit, manage_lists
// capability (signed_in), then the caller's creator (400 no_creator).
export async function requireCreatorForLists(
  routeLabel: string,
  limiterTier: "userWrites" | "chattyAuthUser" = "userWrites",
): Promise<{ creatorId: string } | { error: NextResponse }> {
  const profile = await getCurrentProfile();
  const userId = profile?.userId ?? null;
  const isSuperAdmin = profile?.role === "super_admin";
  if (!userId) {
    return { error: NextResponse.json({ error: "auth_required" }, { status: 401 }) };
  }
  const rl = await enforce(limiterTier, userId, routeLabel);
  if (!rl.ok) return { error: rl.response };
  const tier = await getUserTier(userId);
  const g = canPerform(tier, "manage_lists", 0, isSuperAdmin);
  if (!g.allowed) {
    return { error: NextResponse.json({ error: g.reason }, { status: 403 }) };
  }
  const creatorId = await resolveCreatorId(userId);
  if (!creatorId) {
    return {
      error: NextResponse.json(
        { error: "no_creator — claim a Moonbeem handle first" },
        { status: 400 },
      ),
    };
  }
  return { creatorId };
}

// Lazy find-or-create the creator's single watchlist (one-per-creator partial
// unique enforces uniqueness; a 23505 create race re-finds).
export async function findOrCreateWatchlist(
  sb: SupabaseClient,
  creatorId: string,
): Promise<string> {
  const { data: existing } = await sb
    .from("user_lists")
    .select("id")
    .eq("creator_id", creatorId)
    .eq("kind", "watchlist")
    .maybeSingle();
  if (existing?.id) return existing.id as string;

  const { data: created, error } = await sb
    .from("user_lists")
    .insert({
      creator_id: creatorId,
      name: "Watchlist",
      kind: "watchlist",
      source: "native",
      visibility: "public",
    })
    .select("id")
    .maybeSingle();
  if (!error && created?.id) return created.id as string;
  if (error?.code === "23505") {
    const { data: re } = await sb
      .from("user_lists")
      .select("id")
      .eq("creator_id", creatorId)
      .eq("kind", "watchlist")
      .maybeSingle();
    if (re?.id) return re.id as string;
  }
  throw error ?? new Error("watchlist_create_failed");
}

// Add a title to a list. Idempotent on (list_id, title_id) via an app-level
// dup check, backstopped by the partial unique user_list_items_list_title_unique
// (list_id, title_id) WHERE title_id IS NOT NULL (added 20260610000003). position
// is append-only max+1; retries on a (list_id, position) deferred-unique race.
export async function addItemToList(
  sb: SupabaseClient,
  params: { creatorId: string; listId: string; titleId: string },
): Promise<{ already: boolean }> {
  const { listId, titleId, creatorId } = params;
  // .limit(1) (not .maybeSingle()): a cheap short-circuit so an existing
  // membership returns already=true without attempting an insert. The
  // (list_id, title_id) partial unique now guarantees at most one matched row,
  // but .limit(1) stays dup-tolerant regardless of any legacy pre-index dup.
  const { data: existingRows } = await sb
    .from("user_list_items")
    .select("id")
    .eq("list_id", listId)
    .eq("title_id", titleId)
    .limit(1);
  if (existingRows && existingRows.length > 0) return { already: true };

  for (let attempt = 0; attempt < 3; attempt++) {
    const { data: maxRow } = await sb
      .from("user_list_items")
      .select("position")
      .eq("list_id", listId)
      .order("position", { ascending: false })
      .limit(1)
      .maybeSingle();
    const position = ((maxRow?.position as number | null) ?? 0) + 1;
    const { error } = await sb.from("user_list_items").insert({
      list_id: listId,
      creator_id: creatorId, // ALWAYS the parent list's creator, never the request
      title_id: titleId,
      position,
      source: "native",
    });
    if (!error) return { already: false };
    if (error.code === "23505") {
      // A 23505 here is now one of two uniques: (list_id, title_id) [added
      // 20260610000003] when a concurrent add inserted this title first, or
      // (list_id, position) on a position race. Re-check the pair to tell them
      // apart: if the title already exists, treat as already=true; otherwise it
      // was a position race, so recompute max+1 and retry.
      const { data: dupRows } = await sb
        .from("user_list_items")
        .select("id")
        .eq("list_id", listId)
        .eq("title_id", titleId)
        .limit(1);
      if (dupRows && dupRows.length > 0) return { already: true };
      continue;
    }
    throw error;
  }
  throw new Error("position_conflict");
}

export async function removeItemFromList(
  sb: SupabaseClient,
  listId: string,
  titleId: string,
): Promise<void> {
  await sb
    .from("user_list_items")
    .delete()
    .eq("list_id", listId)
    .eq("title_id", titleId);
}
