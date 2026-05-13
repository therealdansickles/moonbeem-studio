// Shared helper: compute the featured_order value to assign when a
// title transitions from is_featured=false → true. Used by:
//   - PATCH /api/admin/titles/[slug] (toggle from the curation page)
//   - POST  /api/admin/titles/attach  (Activate Title modal checkbox)
// "Append to end" semantics: max(featured_order WHERE is_featured) + 1.
// Returns 1 when nothing is currently featured.

import type { SupabaseClient } from "@supabase/supabase-js";

export async function nextFeaturedOrder(
  supabase: SupabaseClient,
): Promise<number> {
  const { data } = await supabase
    .from("titles")
    .select("featured_order")
    .eq("is_featured", true)
    .order("featured_order", { ascending: false })
    .limit(1)
    .maybeSingle();
  return ((data?.featured_order as number | null) ?? 0) + 1;
}
