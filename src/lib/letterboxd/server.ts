// Phase 2B — server-only helpers for the Letterboxd import routes (gating chain
// + the matcher RPC call). Server-only (Next/Supabase imports), so it uses the
// @/ alias; the pure parse/normalize modules stay node-runnable for the dev gate.

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

// Identical posture to requireCreatorForLists, but the import_letterboxd
// capability (signed_in): JSON 401 anon, userWrites rate limit, capability gate
// (403), then the caller's creator (400 no_creator). Returns userId too — the
// import job + the R2 key namespace are keyed on it.
export async function requireCreatorForImport(
  routeLabel: string,
): Promise<{ userId: string; creatorId: string } | { error: NextResponse }> {
  const profile = await getCurrentProfile();
  const userId = profile?.userId ?? null;
  const isSuperAdmin = profile?.role === "super_admin";
  if (!userId) {
    return { error: NextResponse.json({ error: "auth_required" }, { status: 401 }) };
  }
  const rl = await enforce("userWrites", userId, routeLabel);
  if (!rl.ok) return { error: rl.response };
  const tier = await getUserTier(userId);
  const g = canPerform(tier, "import_letterboxd", 0, isSuperAdmin);
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
  return { userId, creatorId };
}

export type FilmMatch = {
  idx: number;
  title_id: string | null;
  // Returned by the RPC but unused in the 2B preview (which keys on title_id);
  // kept for the 2C apply / telemetry, which may log the resolved TMDb id.
  tmdb_id: number | null;
  slug: string | null;
  matched_via: "exact" | "fuzzy" | "none";
};

// Call match_letterboxd_films(items jsonb). MUST be invoked with the
// service-role client (the RPC is granted to service_role only). Returns one
// row per input ref, in idx order.
export async function matchFilms(
  sb: SupabaseClient,
  refs: Array<{ name: string; year: number | null }>,
): Promise<FilmMatch[]> {
  if (refs.length === 0) return [];
  const { data, error } = await sb.rpc("match_letterboxd_films", { items: refs });
  if (error) throw new Error(`match_letterboxd_films failed: ${error.message}`);
  return (data ?? []) as FilmMatch[];
}
