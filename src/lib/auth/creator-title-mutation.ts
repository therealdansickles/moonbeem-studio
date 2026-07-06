// authorizeCreatorTitleMutation — the shared authorization gate for content-
// mutations on a CREATOR TITLE (the self-serve hosting lane). Mirrors
// authorizeTitleMutation (title-mutation.ts) with the partner-membership branch
// replaced by the CLAIMED-CREATOR check, keeping the same un-forgeable shape:
//
// LOAD-BEARING — this takes the SESSION userId and the CREATOR-TITLE id. It
// does NOT take a creatorId, a role, or any ownership claim from the caller.
// Ownership is resolved INSIDE the helper from the DB (creator_title →
// creator_id → creators.user_id) on every call. If it accepted a creatorId, a
// caller could pass the wrong one and bypass ownership.
//
// The CLAIMED-CREATOR gate: the owning creators row must be live AND claimed
// by the session user (creators.user_id = userId, deleted_at IS NULL — the
// canonical caller-owns-creator predicate, resolveCreatorId shape). A stub
// creator (user_id NULL) can never authorize — a stub has no operator.
//
// Authorization is application-layer: creator_titles/creators reads go through
// the service-role client (creator_* tables are RLS-enabled with ZERO policies,
// deny-all — ruling Q1 Option A), exactly like title_episodes/mux_ingest_jobs.

import { createServiceRoleClient } from "@/lib/supabase/service";

// Discriminated result the callers branch on (AuthzResult style):
//   ok:true            → proceed; creatorId lets the write re-scope belt-and-
//                        suspenders (.eq("creator_id", …)); `via` is for logging.
//   not_authenticated  → no session userId (caller 401s)
//   title_not_found    → no live creator_title with that id (caller 404s, NOT 403)
//   not_authorized     → authenticated but not the claiming creator (caller 403s)
export type CreatorAuthzResult =
  | {
      ok: true;
      creatorTitleId: string;
      creatorId: string;
      via: "super_admin" | "claimed_creator";
    }
  | { ok: false; reason: "not_authenticated" }
  | { ok: false; reason: "title_not_found" }
  | { ok: false; reason: "not_authorized" };

export async function authorizeCreatorTitleMutation(
  userId: string,
  creatorTitleId: string,
): Promise<CreatorAuthzResult> {
  // The caller passes the session userId (from getUser()/verifySession). Guard
  // defensively — an empty/absent id is never authorized.
  if (!userId) return { ok: false, reason: "not_authenticated" };

  const supabase = createServiceRoleClient();

  // 1. Acting user's role + 2. the creator title (id, owning creator). Both
  //    service-role. Soft-delete-scoped exactly as the partner gate scopes
  //    titles.
  const [{ data: userRow }, { data: title }] = await Promise.all([
    supabase.from("users").select("role").eq("id", userId).maybeSingle(),
    supabase
      .from("creator_titles")
      .select("id, creator_id")
      .eq("id", creatorTitleId)
      .is("deleted_at", null)
      .maybeSingle(),
  ]);

  // 2b. No live creator title → 404 (distinct from 403 so the caller can
  //     branch). Precedes the role check: nobody, not even a super-admin,
  //     mutates a title that doesn't exist.
  if (!title) return { ok: false, reason: "title_not_found" };

  const role = (userRow?.role as string | null) ?? null;
  // creator_titles.creator_id is NOT NULL — no unowned branch (unlike the
  // partner gate's nullable partner_id).
  const creatorId = title.creator_id as string;

  // 3. Super-admin bypasses the claimed-creator check (per the partner-gate
  //    precedent), but is still only authorized for a real title.
  if (role === "super_admin") {
    return { ok: true, creatorTitleId, creatorId, via: "super_admin" };
  }

  // 4. Claimed creator: the owning creators row, live, claimed by THIS session
  //    user. user_id NULL (stub) or another user's claim → not_authorized.
  const { data: creator } = await supabase
    .from("creators")
    .select("id")
    .eq("id", creatorId)
    .eq("user_id", userId)
    .is("deleted_at", null)
    .maybeSingle();
  if (creator) {
    return { ok: true, creatorTitleId, creatorId, via: "claimed_creator" };
  }

  return { ok: false, reason: "not_authorized" };
}
