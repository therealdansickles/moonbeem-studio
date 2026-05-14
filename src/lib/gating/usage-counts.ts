// Gating Phase 1 — server-side read/increment of per-user lifetime
// usage counts. Service-role client (writes to user_action_counts
// are server-side only per the table's RLS).

import { createServiceRoleClient } from "@/lib/supabase/service";
import type { Capability } from "./types";

export async function getUsageCount(
  userId: string,
  capability: Capability,
): Promise<number> {
  const supabase = createServiceRoleClient();
  const { data } = await supabase
    .from("user_action_counts")
    .select("count")
    .eq("user_id", userId)
    .eq("capability", capability)
    .maybeSingle();
  return (data?.count as number | null) ?? 0;
}

export async function incrementUsageCount(
  userId: string,
  capability: Capability,
): Promise<void> {
  const supabase = createServiceRoleClient();
  // Atomic upsert-increment — see the increment_user_action_count
  // RPC in migration 20260514000008.
  await supabase.rpc("increment_user_action_count", {
    p_user_id: userId,
    p_capability: capability,
  });
}
