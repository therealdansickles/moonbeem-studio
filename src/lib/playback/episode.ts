// Focused, read-only single-episode lookup for the playback-token endpoint.
//
// Returns an episode's playback-relevant fields PLUS its owning title's
// visibility fields (so the route can call canViewTitle). Uses the service-role
// client (title_episodes has RLS enabled with no policies — service-role only),
// mirroring getTitleEpisodes.
//
// This is intentionally NOT a broadening of getTitleEpisodes / TitleEpisode —
// the Watch-tab plumbing change (adding mux fields to the list query) is a
// separate later step. Keep this lookup scoped to the playback endpoint.

import { createServiceRoleClient } from "@/lib/supabase/service";

export type EpisodeForPlayback = {
  id: string;
  title_id: string;
  source: string;
  mux_playback_id: string | null;
  requires_drm: boolean;
  is_published: boolean;
  // Effective-monetization input (sub-unit 3 gate): the per-episode override.
  // effective = COALESCE(monetization_mode, title.default_monetization_mode).
  monetization_mode: string | null;
  // Owning title's visibility fields + monetization default, or null if the
  // title is missing / soft-deleted (caller treats null as not-viewable).
  // Offer flags (transact_*/purchase_*) feed the playback gate's LIVE
  // sellability derivation — the gate gates exactly when the charge path would
  // sell (enabled === true && integer price > 0), so it no longer reads the
  // stored monetization_mode marker.
  title: {
    is_public: boolean;
    partner_id: string | null;
    default_monetization_mode: string;
    transact_enabled: boolean;
    purchase_enabled: boolean;
    transact_price_cents: number | null;
    purchase_price_cents: number | null;
  } | null;
};

export async function getEpisodeForPlayback(
  episodeId: string,
): Promise<EpisodeForPlayback | null> {
  const supabase = createServiceRoleClient();

  const { data: ep, error } = await supabase
    .from("title_episodes")
    .select(
      "id, title_id, source, mux_playback_id, requires_drm, is_published, monetization_mode",
    )
    .eq("id", episodeId)
    .maybeSingle();
  if (error || !ep) return null;

  const row = ep as Omit<EpisodeForPlayback, "title">;

  // Owning title's visibility (soft-delete-scoped, like every other title read).
  const { data: title } = await supabase
    .from("titles")
    .select(
      "is_public, partner_id, default_monetization_mode, transact_enabled, purchase_enabled, transact_price_cents, purchase_price_cents",
    )
    .eq("id", row.title_id)
    .is("deleted_at", null)
    .maybeSingle();

  return {
    ...row,
    title:
      (title as {
        is_public: boolean;
        partner_id: string | null;
        default_monetization_mode: string;
        transact_enabled: boolean;
        purchase_enabled: boolean;
        transact_price_cents: number | null;
        purchase_price_cents: number | null;
      } | null) ?? null,
  };
}
