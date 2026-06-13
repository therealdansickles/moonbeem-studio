// SEC-1 — per-platform submission ownership gate. SINGLE SOURCE OF TRUTH,
// reused verbatim by all three callers: the insert chokepoint
// (adminInsertFanEdit), the single-route fast pre-check, and the admin
// approve-time backstop.
//
// Rule: a creator may only submit a fan edit from a platform — ideally an
// account — they have VERIFIED via bio code (creator_socials.verified_at
// IS NOT NULL). The platform vocabulary is identical across the URL parser,
// fan_edits.platform, and creator_socials.platform, so platform matching is
// a plain equality; handles compare case-insensitively (mirrors the DB's
// UNIQUE (platform, lower(handle))). No (creator_id, platform) unique
// exists, so the evaluator matches ANY of the creator's verified socials on
// the platform — never assumes a single row.

import type { SupabaseClient } from "@supabase/supabase-js";

export type OwnershipResult =
  | { ok: true; level: "platform" | "handle" }
  | { ok: false; reason: "platform_not_verified" }
  | {
      ok: false;
      reason: "handle_mismatch";
      detail: { platform: string; expected: string[]; got: string };
    };

// A creator's verified social on the submitted platform — only the handle
// is needed by the evaluator (caller has already filtered by platform +
// verified_at).
export type VerifiedSocial = { handle: string | null };

// Strip a leading @ and surrounding whitespace; empty → null. Case is
// preserved (comparisons lowercase both sides).
function normalizeHandle(h: string | null | undefined): string | null {
  if (!h) return null;
  const stripped = h.replace(/^@+/, "").trim();
  return stripped.length > 0 ? stripped : null;
}

// PURE evaluator over the creator's VERIFIED socials ON THE SUBMITTED
// PLATFORM (already filtered by the caller). No I/O — unit-reasoned.
export function evaluateSubmissionOwnership(args: {
  platform: string;
  authorHandle: string | null;
  verifiedSocialsOnPlatform: VerifiedSocial[];
}): OwnershipResult {
  const { platform, authorHandle, verifiedSocialsOnPlatform } = args;

  // (1) No verified social on this platform → hard reject.
  if (verifiedSocialsOnPlatform.length === 0) {
    return { ok: false, reason: "platform_not_verified" };
  }

  // Verified handles present on this platform (non-null only).
  const verifiedHandles = verifiedSocialsOnPlatform
    .map((s) => normalizeHandle(s.handle))
    .filter((h): h is string => h !== null);

  const author = normalizeHandle(authorHandle);

  // (2) Author handle known AND ≥1 verified social carries a handle →
  // require a case-insensitive match against ANY verified handle.
  if (author !== null && verifiedHandles.length > 0) {
    const got = author.toLowerCase();
    const matched = verifiedHandles.some((h) => h.toLowerCase() === got);
    if (!matched) {
      return {
        ok: false,
        reason: "handle_mismatch",
        detail: { platform, expected: verifiedHandles, got: author },
      };
    }
    return { ok: true, level: "handle" };
  }

  // (3) Author handle unknown (YouTube always; IG fetch-fail; Twitter
  // /i/status) OR no verified social carries a handle → platform-level
  // pass (a verified social on this platform exists, proven in step 1).
  return { ok: true, level: "platform" };
}

// DB-loading assert: loads the creator's VERIFIED socials on `platform`,
// then delegates to the pure evaluator. THROWS only on an unexpected DB
// error — callers wrap it and convert to a typed failure (never a silent
// pass, never a throw across an after() boundary).
export async function assertSubmissionOwnership(
  sb: SupabaseClient,
  args: { creatorId: string; platform: string; authorHandle: string | null },
): Promise<OwnershipResult> {
  const { creatorId, platform, authorHandle } = args;
  const { data, error } = await sb
    .from("creator_socials")
    .select("handle")
    .eq("creator_id", creatorId)
    .eq("platform", platform)
    .not("verified_at", "is", null);
  if (error) {
    throw new Error(`creator_socials lookup failed: ${error.message}`);
  }
  return evaluateSubmissionOwnership({
    platform,
    authorHandle,
    verifiedSocialsOnPlatform: (data ?? []) as VerifiedSocial[],
  });
}
