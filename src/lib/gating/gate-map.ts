// Gating Phase 1 — the single source of truth mapping every
// capability to a GateConfig per tier. canPerform() reads this;
// nothing else encodes tier rules.
//
// Note: a GateConfig of { allowed: true } here gates the UI flow for
// that capability, not the underlying asset. For clip/still
// downloads the raw R2 file URLs remain publicly accessible (the
// video player needs them) — hard enforcement (private files +
// signed URLs) is the Phase 4 backlog item.

import type { Capability, GateConfig, Tier } from "./types";

export const gateMap: Record<Capability, Record<Tier, GateConfig>> = {
  browse_titles: {
    anonymous: { allowed: true },
    signed_in: { allowed: true },
    verified: { allowed: true },
  },
  watch_fan_edit: {
    anonymous: { allowed: true },
    signed_in: { allowed: true },
    verified: { allowed: true },
  },
  purchase_rental: {
    anonymous: { allowed: true },
    signed_in: { allowed: true },
    verified: { allowed: true },
  },
  view_public_profile: {
    anonymous: { allowed: true },
    signed_in: { allowed: true },
    verified: { allowed: true },
  },

  save_to_top12: {
    anonymous: { allowed: false },
    signed_in: { allowed: true },
    verified: { allowed: true },
  },
  download_clip: {
    anonymous: { allowed: false },
    signed_in: { allowed: true, limit: { type: "lifetime", count: 3 } },
    verified: { allowed: true },
  },
  download_still: {
    anonymous: { allowed: false },
    signed_in: { allowed: true, limit: { type: "lifetime", count: 10 } },
    verified: { allowed: true },
  },

  upload_fan_edit: {
    anonymous: { allowed: false },
    signed_in: { allowed: false },
    verified: { allowed: true },
  },
  download_all_zip: {
    anonymous: { allowed: false },
    signed_in: { allowed: false },
    verified: { allowed: true },
  },
  earn_from_views: {
    anonymous: { allowed: false },
    signed_in: { allowed: false },
    verified: { allowed: true },
  },
  claim_attribution: {
    anonymous: { allowed: false },
    signed_in: { allowed: false },
    verified: { allowed: true },
  },
};
