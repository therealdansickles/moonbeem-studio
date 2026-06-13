// Phase 2E.1 — watched count for a public profile. Anon SSR client (the
// watched_titles "public read" RLS policy scopes anon to visibility='public');
// the defensive .eq('visibility','public') is load-bearing for a signed-in
// viewer whose owner-RLS would otherwise ALSO return their own private rows
// (the 1B pattern). Count-only (head:true) — no rows are fetched.

import { getUser } from "@/lib/dal";
import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service";

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

// Phase 2E.2 — is the given title in the signed-in caller's watched set? (title-
// page toggle initial state — service-role to resolve the creator, anon owner-
// RLS read.) ANY watched row counts (imported-private OR native-public): the
// film is watched either way, so the toggle shows "on" — unlike the star
// control, which hides unattested imports.
export async function getMyWatchedStateForTitle(
  titleId: string,
): Promise<boolean> {
  const user = await getUser();
  if (!user) return false;
  const service = createServiceRoleClient();
  const { data: creator } = await service
    .from("creators")
    .select("id")
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!creator?.id) return false;

  const supabase = await createClient();
  // .limit(1) (not maybeSingle): the (creator_id, title_id) partial unique keeps
  // this <=1, but stay dup-tolerant. Owner-all RLS covers reading own rows.
  const { data: rows } = await supabase
    .from("watched_titles")
    .select("id")
    .eq("creator_id", creator.id as string)
    .eq("title_id", titleId)
    .limit(1);
  return Boolean(rows && rows.length > 0);
}
