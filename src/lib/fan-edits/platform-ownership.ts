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
  // SEC-2: matchedHandle is the eligible post-author (owner OR a verified
  // coauthor) that the submitter's verified social matched, set only on a
  // handle-level pass. The caller persists it so the approve backstop
  // re-checks the same handle that cleared the gate.
  | { ok: true; level: "platform" | "handle"; matchedHandle?: string }
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
  // SEC-2: usernames of VERIFIED coauthors (instagram coauthor_producers).
  // Empty/absent on non-IG and on posts with no verified coauthors.
  coauthorHandles?: string[];
  verifiedSocialsOnPlatform: VerifiedSocial[];
}): OwnershipResult {
  const {
    platform,
    authorHandle,
    coauthorHandles = [],
    verifiedSocialsOnPlatform,
  } = args;

  // (1) No verified social on this platform → hard reject.
  if (verifiedSocialsOnPlatform.length === 0) {
    return { ok: false, reason: "platform_not_verified" };
  }

  // Verified handles present on this platform (non-null only).
  const verifiedHandles = verifiedSocialsOnPlatform
    .map((s) => normalizeHandle(s.handle))
    .filter((h): h is string => h !== null);

  // SEC-2: the eligible post-author set is the owner/URL handle PLUS any
  // VERIFIED coauthor. The submitter clears the gate if verified as ANY of
  // them. Normalize + dedupe (case-insensitive); preserve order so the
  // owner stays primary (used for the handle_mismatch message).
  const eligibleAuthors: string[] = [];
  for (const raw of [authorHandle, ...coauthorHandles]) {
    const h = normalizeHandle(raw);
    if (h && !eligibleAuthors.some((e) => e.toLowerCase() === h.toLowerCase())) {
      eligibleAuthors.push(h);
    }
  }

  // (2) ≥1 eligible author known AND ≥1 verified social carries a handle →
  // require a case-insensitive match between SOME eligible author and SOME
  // verified handle. The matched eligible author is returned so the caller
  // can persist it (byline + the approve-backstop re-check handle).
  if (eligibleAuthors.length > 0 && verifiedHandles.length > 0) {
    const verifiedLower = new Set(verifiedHandles.map((h) => h.toLowerCase()));
    const matchedHandle = eligibleAuthors.find((a) =>
      verifiedLower.has(a.toLowerCase()),
    );
    if (matchedHandle === undefined) {
      return {
        ok: false,
        reason: "handle_mismatch",
        // got = the primary author (owner) for the user-facing message.
        detail: { platform, expected: verifiedHandles, got: eligibleAuthors[0] },
      };
    }
    return { ok: true, level: "handle", matchedHandle };
  }

  // (3) No author handle known (YouTube always; IG fetch-fail; Twitter
  // /i/status; no coauthors) OR no verified social carries a handle →
  // platform-level pass (a verified social on this platform exists, proven
  // in step 1).
  return { ok: true, level: "platform" };
}

// DB-loading assert: loads the creator's VERIFIED socials on `platform`,
// then delegates to the pure evaluator. THROWS only on an unexpected DB
// error — callers wrap it and convert to a typed failure (never a silent
// pass, never a throw across an after() boundary).
export async function assertSubmissionOwnership(
  sb: SupabaseClient,
  args: {
    creatorId: string;
    platform: string;
    authorHandle: string | null;
    // SEC-2: VERIFIED coauthor handles surfaced by the mapper (IG only).
    coauthorHandles?: string[];
  },
): Promise<OwnershipResult> {
  const { creatorId, platform, authorHandle, coauthorHandles } = args;
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
    coauthorHandles,
    verifiedSocialsOnPlatform: (data ?? []) as VerifiedSocial[],
  });
}
