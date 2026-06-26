// Service-role entitlement reads + the first-play stamp for the playback gate
// (transactions sub-unit 3). `entitlements` has RLS enabled with no policies, so
// these go through the service-role client (mirroring getEpisodeForPlayback).

import { createServiceRoleClient } from "@/lib/supabase/service";
import { isEntitlementActive } from "@/lib/entitlements/window";

export type ActiveEntitlement = {
  id: string;
  kind: string;
  purchased_at: string;
  first_played_at: string | null;
};

// The single ACTIVE entitlement for (userId, titleId), or null. There may be >1
// row for the pair (a legit re-rent after expiry); we evaluate each through
// isEntitlementActive — the SAME two-clock rule the charge-init double-pay guard
// uses (imported verbatim, never reimplemented) — and, defensively, return the
// most recent active one. Returns the row INCLUDING its id (the stamp needs it).
// Uses idx_entitlements_user_title.
export async function getActiveEntitlement(
  userId: string,
  titleId: string,
): Promise<ActiveEntitlement | null> {
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from("entitlements")
    .select("id, kind, purchased_at, first_played_at")
    .eq("user_id", userId)
    .eq("title_id", titleId)
    .order("purchased_at", { ascending: false });
  if (error || !data || data.length === 0) return null;

  // data is purchased_at DESC, so the first active row IS the most recent active.
  for (const r of data as ActiveEntitlement[]) {
    if (
      isEntitlementActive({
        kind: r.kind,
        purchased_at: r.purchased_at,
        first_played_at: r.first_played_at ?? null,
      })
    ) {
      return r;
    }
  }
  return null;
}

// Stamp first_played_at exactly-once, at DB time, arming the 48h rental clock.
// Idempotent: the RPC's conditional UPDATE (WHERE first_played_at IS NULL) stamps
// on the first play and no-ops (0 rows) on every later play. DB now() (NOT a JS
// Date) so the clock can't skew — which is why this is an RPC: PostgREST can't set
// a column to now() in an update. Fire-and-proceed: a 0-row result is the EXPECTED
// case on 2nd+ play; a transient error is logged, never blocks the mint.
export async function stampFirstPlay(entitlementId: string): Promise<void> {
  const supabase = createServiceRoleClient();
  const { error } = await supabase.rpc("stamp_first_play", {
    p_entitlement_id: entitlementId,
  });
  if (error) {
    console.error(
      `[entitlements] stamp_first_play failed for ${entitlementId}: ${error.message}`,
    );
  }
}
