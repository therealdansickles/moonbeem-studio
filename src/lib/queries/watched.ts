// Phase 2E.1 — watched count for a public profile. Anon SSR client (the
// watched_titles "public read" RLS policy scopes anon to visibility='public');
// the defensive .eq('visibility','public') is load-bearing for a signed-in
// viewer whose owner-RLS would otherwise ALSO return their own private rows
// (the 1B pattern). Count-only (head:true) — no rows are fetched.

import { createClient } from "@/lib/supabase/server";

export async function getWatchedCountForCreator(
  creatorId: string,
): Promise<number> {
  const supabase = await createClient();
  const { count } = await supabase
    .from("watched_titles")
    .select("id", { count: "exact", head: true })
    .eq("creator_id", creatorId)
    .eq("visibility", "public");
  return count ?? 0;
}
