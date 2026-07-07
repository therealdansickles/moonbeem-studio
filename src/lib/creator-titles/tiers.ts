// Creator hosting tiers — the Phase-3/4 billing contract. Single home for the
// tier ladder, the allotments, and the gate math. Both the /me dashboard and
// the mux-upload gate read getCreatorHostingStatus() so they can never drift.
//
// Unit = ENCODE-MINUTES (Phase 2, ruling D1). getCreatorTier() derives the tier
// from creator_subscriptions (the source of truth) — NOT creators.tier, which is
// a pre-existing clearance enum. Free = no active subscription.
//
// Gate math (ruling): billable = max(0, used_encode_minutes - grandfathered_floor);
// the grandfather floor (permanent-zero pre-tier minutes, snapshotted at launch)
// is on creators.grandfathered_encode_minutes. atCeiling = billable >= allotment.

import { createServiceRoleClient } from "@/lib/supabase/service";
import { getCreatorStorageUsage } from "@/lib/creator-titles/storage";

export type CreatorTier = "free" | "solo" | "studio" | "pro";

// Paid tiers as stored in creator_subscriptions.tier (free is never a row).
export type PaidTier = Exclude<CreatorTier, "free">;

// The ladder (Dan's final pricing word). Allotments in ENCODE-MINUTES.
export const TIER_ALLOTMENT_MINUTES: Record<CreatorTier, number> = {
  free: 120,
  solo: 600,
  studio: 2400,
  pro: 9000,
};

export const TIER_PRICE_USD: Record<CreatorTier, number> = {
  free: 0,
  solo: 15,
  studio: 39,
  pro: 99,
};

// 4K gates to Studio and up (4K ≈ 3.2× cost); free/solo are HD-capped. Enforced
// at upload via max_stored_resolution.
export const TIER_ALLOWS_4K: Record<CreatorTier, boolean> = {
  free: false,
  solo: false,
  studio: true,
  pro: true,
};

// ⚠️ PHASE-6 INTENT ONLY — do NOT align the upload/finalize to this constant
// without a ruling. Protection is UNIVERSAL DRM today (Phase-3 precedent: the
// mux-upload route always requests advanced_playback_policies:[{policy:"drm"}],
// and the webhook finalize is DRM-only fail-closed). The intended Phase-6 split
// — free = policy-DRM (signed-URL "protected hosting"), Solo+ = full multi-DRM
// (Widevine/FairPlay "DRM") — is DEFERRED; wiring it means branching the upload
// AND relaxing the hardened DRM-only finalize, which is a separate decision.
// Nothing reads this map for the upload policy yet; it documents the future gate.
export const TIER_MULTI_DRM: Record<CreatorTier, boolean> = {
  free: false,
  solo: true,
  studio: true,
  pro: true,
};

// Fair-streaming reserve — an UNENFORCED watch-threshold (delivered hours/month)
// per tier. Posture is congratulate-and-upgrade, never cutoff (Dan's ruling); we
// do not gate on it, we watch it. ~2000 streamed hours/mo on Solo, scaled by
// allotment. Kept here as the documented reserve for the ops watch, not a gate.
export const TIER_FAIR_STREAM_HOURS_MONTH: Record<PaidTier, number> = {
  solo: 2000,
  studio: 8000,
  pro: 30000,
};

export const PAID_TIER_ORDER: PaidTier[] = ["solo", "studio", "pro"];

// The tier a creator is ON right now: the tier of their live (active|trialing)
// subscription, else 'free'. The uq_creator_subscriptions_one_live partial
// unique guarantees at most one live row, so maybeSingle is safe.
export async function getCreatorTier(creatorId: string): Promise<CreatorTier> {
  const supabase = createServiceRoleClient();
  const { data } = await supabase
    .from("creator_subscriptions")
    .select("tier")
    .eq("creator_id", creatorId)
    .in("status", ["active", "trialing"])
    .maybeSingle();
  return ((data?.tier as PaidTier | undefined) ?? "free") as CreatorTier;
}

export type CreatorHostingStatus = {
  tier: CreatorTier;
  priceUsd: number;
  allotmentMinutes: number;
  usedEncodeMinutes: number; // raw view total (incl. grandfathered)
  grandfatheredFloorMinutes: number;
  billableMinutes: number; // max(0, used - floor) — what counts against the cap
  remainingMinutes: number; // max(0, allotment - billable)
  atCeiling: boolean; // billable >= allotment → block new uploads (soft)
  allows4k: boolean;
  multiDrm: boolean;
  pendingCancel: boolean; // scheduled to cancel (cancel_at set OR cape true)
  cancelAt: string | null; // ISO scheduled-cancel timestamp, for the display line
};

// The single status object the gate + dashboard both read. One service-role
// read of the tier + one of the grandfather floor, plus the storage view.
export async function getCreatorHostingStatus(
  creatorId: string,
): Promise<CreatorHostingStatus> {
  const supabase = createServiceRoleClient();
  const [tier, usage, floorRow, subRow] = await Promise.all([
    getCreatorTier(creatorId),
    getCreatorStorageUsage(creatorId),
    supabase
      .from("creators")
      .select("grandfathered_encode_minutes")
      .eq("id", creatorId)
      .maybeSingle(),
    // The live sub's scheduled-cancel signal. Flexible billing sets cancel_at
    // (a timestamp) and leaves cancel_at_period_end false; either means pending.
    supabase
      .from("creator_subscriptions")
      .select("cancel_at, cancel_at_period_end")
      .eq("creator_id", creatorId)
      .in("status", ["active", "trialing"])
      .maybeSingle(),
  ]);

  const allotmentMinutes = TIER_ALLOTMENT_MINUTES[tier];
  const usedEncodeMinutes = usage.encodeMinutes;
  const grandfatheredFloorMinutes = Number(
    floorRow.data?.grandfathered_encode_minutes ?? 0,
  );
  // Permanent-zero: pre-tier minutes never count against the cap. Clamp at 0 so
  // deleting grandfathered content (Phase 6) can't push billable negative.
  const billableMinutes = Math.max(
    0,
    usedEncodeMinutes - grandfatheredFloorMinutes,
  );
  const remainingMinutes = Math.max(0, allotmentMinutes - billableMinutes);

  // Pending cancellation: cancel_at set (flexible) OR cancel_at_period_end
  // (legacy). cancelAt is the scheduled end date for the "Cancels …" line.
  const cancelAt = (subRow.data?.cancel_at as string | null) ?? null;
  const pendingCancel = cancelAt != null || !!subRow.data?.cancel_at_period_end;

  return {
    tier,
    priceUsd: TIER_PRICE_USD[tier],
    allotmentMinutes,
    usedEncodeMinutes,
    grandfatheredFloorMinutes,
    billableMinutes,
    remainingMinutes,
    atCeiling: billableMinutes >= allotmentMinutes,
    allows4k: TIER_ALLOWS_4K[tier],
    multiDrm: TIER_MULTI_DRM[tier],
    pendingCancel,
    cancelAt,
  };
}
