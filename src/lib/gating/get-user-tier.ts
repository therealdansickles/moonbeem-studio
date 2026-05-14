// Gating Phase 1 — resolves a user id to their tier. Server-only
// (uses the service-role client: creator_socials has RLS with no
// public SELECT policy).
//
//   no userId            -> anonymous
//   userId, no verified   -> signed_in
//   userId + >= 1 verified social -> verified
//
// "verified" = at least one creator_socials row with verified_at set,
// reached via creators (the user's non-deleted creator row).

import { createServiceRoleClient } from "@/lib/supabase/service";
import type { Tier } from "./types";

export async function getUserTier(userId: string | null): Promise<Tier> {
  if (!userId) return "anonymous";

  const supabase = createServiceRoleClient();

  const { data: creator } = await supabase
    .from("creators")
    .select("id")
    .eq("user_id", userId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!creator) return "signed_in";

  const { count } = await supabase
    .from("creator_socials")
    .select("id", { count: "exact", head: true })
    .eq("creator_id", creator.id)
    .not("verified_at", "is", null);

  return (count ?? 0) > 0 ? "verified" : "signed_in";
}
