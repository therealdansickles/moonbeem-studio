// authorizeTitleMutation — the shared authorization gate for content-mutations
// on a TITLE (poster edit, episode add, …). Mirrors the canonical partner-route
// pattern (super_admin OR owning-partner-admin) used by the 5 existing
// /api/p/[slug]/* write routes (e.g. clips/[id] PATCH:50-64 + its title→partner
// resource-scoping :87-122), lifted into one reusable predicate.
//
// LOAD-BEARING — the un-forgeable shape: this takes the SESSION userId and the
// TITLE id. It does NOT take a partnerId, a role, or any ownership claim from the
// caller. Ownership is resolved INSIDE the helper from the DB (title → partner_id
// → partner_users membership) on every call. If it accepted a partnerId, a caller
// could pass the wrong one and bypass ownership. Same principle as the follow
// feature's server-side actor resolution.
//
// Authorization is application-layer: the title + partner_users reads go through
// the service-role client (partner_users has RLS with no public SELECT; titles is
// RLS-gated), exactly as the existing partner routes do. Resources are written via
// service-role, so THIS helper is the gate.

import { createServiceRoleClient } from "@/lib/supabase/service";

// Discriminated result the callers branch on (FollowOutcome style):
//   ok:true            → proceed; partnerId lets the write re-scope belt-and-
//                        suspenders (.eq("partner_id", …)); `via` is for logging.
//   not_authenticated  → no session userId (caller 401s)
//   title_not_found    → no live title with that id (caller 404s, NOT 403)
//   not_authorized     → authenticated but not allowed (caller 403s)
export type AuthzResult =
  | {
      ok: true;
      titleId: string;
      partnerId: string | null;
      via: "super_admin" | "partner_admin";
    }
  | { ok: false; reason: "not_authenticated" }
  | { ok: false; reason: "title_not_found" }
  | { ok: false; reason: "not_authorized" };

export async function authorizeTitleMutation(
  userId: string,
  titleId: string,
): Promise<AuthzResult> {
  // The caller passes the session userId (from getUser()/verifySession). Guard
  // defensively — an empty/absent id is never authorized.
  if (!userId) return { ok: false, reason: "not_authenticated" };

  const supabase = createServiceRoleClient();

  // 1. Acting user's role + 2. the title (id, owning partner). Both service-role.
  //    The title is soft-delete-scoped (deleted_at IS NULL) exactly as titles are
  //    read everywhere else (title-access.ts, queries/titles.ts).
  const [{ data: userRow }, { data: title }] = await Promise.all([
    supabase.from("users").select("role").eq("id", userId).maybeSingle(),
    supabase
      .from("titles")
      .select("id, partner_id")
      .eq("id", titleId)
      .is("deleted_at", null)
      .maybeSingle(),
  ]);

  // 2b. No live title → 404 (distinct from 403 so the caller can branch). This
  //     precedes the role check: nobody, not even a super-admin, mutates a title
  //     that doesn't exist.
  if (!title) return { ok: false, reason: "title_not_found" };

  const role = (userRow?.role as string | null) ?? null;
  const partnerId = (title.partner_id as string | null) ?? null;

  // 3. Super-admin bypasses the partner check entirely (per precedent), but is
  //    still only authorized for a real title (checked above).
  if (role === "super_admin") {
    return { ok: true, titleId, partnerId, via: "super_admin" };
  }

  // 4. Unowned title (general catalog) → super-admin only. The partner branch
  //    can't match a NULL partner_id, so deny.
  if (partnerId === null) return { ok: false, reason: "not_authorized" };

  // 5. Owning-partner-admin: a live partner_users membership for THIS title's
  //    partner, role 'admin' (mirrors all 5 partner write routes — not loosened
  //    to any partner role).
  const { data: membership } = await supabase
    .from("partner_users")
    .select("role")
    .eq("partner_id", partnerId)
    .eq("user_id", userId)
    .is("deleted_at", null)
    .maybeSingle();
  if (membership && membership.role === "admin") {
    return { ok: true, titleId, partnerId, via: "partner_admin" };
  }

  return { ok: false, reason: "not_authorized" };
}
