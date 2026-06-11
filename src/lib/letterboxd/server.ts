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
  // 2B.1: full-catalog match. is_public distinguishes a LIVE title (links to
  // /t/{slug}) from a catalog-only match — a staged title matched but not yet
  // published. Null when matched_via = 'none'.
  is_public: boolean | null;
  matched_via: "exact" | "fuzzy" | "none";
};

// Call match_letterboxd_films(items jsonb). MUST be invoked with the
// service-role client (the RPC is granted to service_role only). Returns one
// row per input ref, in idx order.
//
// 2B.1: chunk at 100 refs per call, sequential. The matcher is index-served, but
// one RPC over a whole library (recon: 836 unique refs) can still exceed
// service_role's ~8s statement_timeout; 100-ref chunks keep each call well inside
// budget. The RPC's idx is 0-based WITHIN its chunk, so re-base it to the global
// ref position before concatenating. A chunk failure fails the whole job, naming
// the offending chunk's range.
const MATCH_CHUNK = 100;

export async function matchFilms(
  sb: SupabaseClient,
  refs: Array<{ name: string; year: number | null }>,
): Promise<FilmMatch[]> {
  if (refs.length === 0) return [];
  const out: FilmMatch[] = [];
  for (let start = 0; start < refs.length; start += MATCH_CHUNK) {
    const chunk = refs.slice(start, start + MATCH_CHUNK);
    const { data, error } = await sb.rpc("match_letterboxd_films", { items: chunk });
    if (error) {
      const end = start + chunk.length - 1;
      throw new Error(
        `match_letterboxd_films failed on chunk ${start}–${end} of ${refs.length} refs: ${error.message}`,
      );
    }
    for (const row of (data ?? []) as FilmMatch[]) {
      // Re-base the chunk-local idx (0..chunk.length-1) to the global ref index.
      out.push({ ...row, idx: row.idx + start });
    }
  }
  return out;
}
