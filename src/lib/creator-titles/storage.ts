// Creator storage meter (Phase 2). Single home for reading per-creator storage
// usage, mirroring getAffiliateBalance (lib/affiliate/balance.ts): a service-role
// read of ONE canonical source so every consumer sees the same number.
//
// The canonical source is the creator_storage_usage VIEW (ruling D3) — an
// on-read SUM over live creator_episodes, so it is deletion-truthful for free
// and IS the Phase-3 tier-gate interface contract. This helper only wraps it;
// the view is where the aggregation lives.
//
// Unit = ENCODE-MINUTES (ruling D1) — the unit Mux bills storage in. numeric
// columns arrive from PostgREST as strings, so coerce with Number().

import { createServiceRoleClient } from "@/lib/supabase/service";

export type CreatorStorageUsage = {
  totalDurationSeconds: number;
  encodeMinutes: number;
  episodeCount: number;
};

const ZERO: CreatorStorageUsage = {
  totalDurationSeconds: 0,
  encodeMinutes: 0,
  episodeCount: 0,
};

export async function getCreatorStorageUsage(
  creatorId: string,
): Promise<CreatorStorageUsage> {
  const supabase = createServiceRoleClient();
  // The view has one row per creator that has at least one live episode; a
  // creator with no hosted video simply has no row → zero usage.
  const { data } = await supabase
    .from("creator_storage_usage")
    .select("total_duration_seconds, encode_minutes, episode_count")
    .eq("creator_id", creatorId)
    .maybeSingle();
  if (!data) return ZERO;
  return {
    totalDurationSeconds: Number(data.total_duration_seconds ?? 0),
    encodeMinutes: Number(data.encode_minutes ?? 0),
    episodeCount: Number(data.episode_count ?? 0),
  };
}
