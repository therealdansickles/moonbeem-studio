// Shared helper: compute the marquee_order to assign when a partner
// transitions from is_marquee_visible=false → true. Used by:
//   - PATCH /api/admin/partners/[id]          (toggle from curation page)
//   - POST  /api/admin/partners               (new partner via standalone create)
//   - POST  /api/admin/titles/attach (new_partner branch)
// "Append to end" semantics: max(marquee_order WHERE is_marquee_visible) + 1.
// Returns 1 when no visible partners exist yet.
//
// Mirrors nextFeaturedOrder() in shape — intentionally two helpers
// instead of a single generic, so call sites read with concrete intent.

import type { SupabaseClient } from "@supabase/supabase-js";

export async function nextMarqueeOrder(
  supabase: SupabaseClient,
): Promise<number> {
  const { data } = await supabase
    .from("partners")
    .select("marquee_order")
    .eq("is_marquee_visible", true)
    .order("marquee_order", { ascending: false })
    .limit(1)
    .maybeSingle();
  return ((data?.marquee_order as number | null) ?? 0) + 1;
}
