// Gating Phase 1 — shared types for the three-tier capability model.
//
// Tiers: anonymous (no session) < signed_in (session, no verified
// social) < verified (session + >= 1 verified social handle).
// Capabilities are mapped to per-tier GateConfig in gate-map.ts.

export type Tier = "anonymous" | "signed_in" | "verified";

export type Capability =
  | "browse_titles"
  | "watch_fan_edit"
  | "purchase_rental"
  | "view_public_profile"
  | "save_to_top12"
  | "rate_title"
  | "write_review"
  | "download_clip"
  | "download_still"
  | "upload_fan_edit"
  | "download_all_zip"
  | "earn_from_views"
  | "claim_attribution";

export type GateConfig =
  | { allowed: true }
  | { allowed: false }
  | { allowed: true; limit: { type: "lifetime"; count: number } };

export type CanPerformResult =
  | { allowed: true }
  | {
      allowed: false;
      reason: "auth_required" | "verification_required" | "limit_reached";
      limit?: number;
      used?: number;
    };
