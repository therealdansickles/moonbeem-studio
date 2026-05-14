// Gating Phase 1 — the pure decision function. Given a tier, a
// capability, the user's current lifetime usage, and whether they're
// a super-admin, returns whether the action is allowed and (if not)
// why. No I/O — callers fetch tier + usage and pass them in. Safe to
// import on the client (e.g. to render quota affordances proactively).

import type { Capability, CanPerformResult, Tier } from "./types";
import { gateMap } from "./gate-map";

export function canPerform(
  tier: Tier,
  capability: Capability,
  currentUsage: number = 0,
  isSuperAdmin: boolean = false,
): CanPerformResult {
  // Super-admins are operationally privileged — they bypass tiers
  // and quotas entirely, and their usage is never counted.
  if (isSuperAdmin) return { allowed: true };

  const config = gateMap[capability][tier];

  // Hard deny — the gap is auth (anonymous) or verification (signed
  // in but the capability needs a verified social).
  if (!config.allowed) {
    return {
      allowed: false,
      reason: tier === "anonymous" ? "auth_required" : "verification_required",
    };
  }

  // Allowed, but quota-limited.
  if ("limit" in config) {
    if (currentUsage >= config.limit.count) {
      return {
        allowed: false,
        reason: "limit_reached",
        limit: config.limit.count,
        used: currentUsage,
      };
    }
    return { allowed: true };
  }

  // Fully allowed.
  return { allowed: true };
}
