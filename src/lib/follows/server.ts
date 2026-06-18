// Follow feature — Step 2: server layer (follow / unfollow / status).
//
// THE LOAD-BEARING RULE: the follower (actor) id ALWAYS comes from
// resolveCreatorId(session user id), resolved server-side. It is NEVER taken
// from client input. The target id is client-supplied. They are sourced
// differently on purpose — if both came from the request body, that's the
// forged-follow bug. The two are visually distinct below: `followerCreatorId`
// is derived from `getUser()`, `target` is the function argument.
//
// WRITE PATH: both writes go through createServiceRoleClient(), with ownership
// enforced here in app code via resolveCreatorId — identical to the seven
// canonical owner-scoped tables (watched_titles, user_lists, ...) per
// src/lib/lists/server.ts. The follows owner-write RLS policy is the
// fail-closed backstop, not the happy path (Step 1 proved a direct
// authenticated write fails 42501). Counters are maintained by the AFTER
// INSERT/DELETE trigger — app code NEVER touches follower_count/following_count
// directly.

import { getUser } from "@/lib/dal";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { resolveCreatorId } from "@/lib/lists/server";
import type { SupabaseClient } from "@supabase/supabase-js";

// Structured result, never an exception. The client must distinguish three
// outcomes: success, "no creator — go claim a handle" (a conversion prompt,
// NOT a failure), and a genuine error. no_creator is deliberately NOT
// collapsed into "error". auth_required is split out so an anon caller routes
// to sign-in rather than onboarding.
export type FollowOutcome =
  | { ok: true; isFollowing: boolean; followerCount: number }
  | { ok: false; reason: "auth_required" }
  | { ok: false; reason: "no_creator" }
  | { ok: false; reason: "self_follow" }
  | { ok: false; reason: "target_not_found" }
  | { ok: false; reason: "error" };

async function readFollowerCount(
  sb: SupabaseClient,
  creatorId: string,
): Promise<number> {
  // Counts come from the denormalized column the trigger maintains — never
  // count(*) on this path.
  const { data } = await sb
    .from("creators")
    .select("follower_count")
    .eq("id", creatorId)
    .maybeSingle();
  return (data?.follower_count as number | null) ?? 0;
}

export async function followCreator(
  targetCreatorId: string,
): Promise<FollowOutcome> {
  const user = await getUser();
  if (!user) return { ok: false, reason: "auth_required" };

  // ACTOR — derived from the session, never from client input.
  const followerCreatorId = await resolveCreatorId(user.id);
  if (!followerCreatorId) return { ok: false, reason: "no_creator" };

  // TARGET — client-supplied. Sourced differently from the actor by design.
  const target = (targetCreatorId ?? "").trim();
  if (!target) return { ok: false, reason: "target_not_found" };

  // Self-follow guard (defense in depth — the CHECK constraint also blocks it).
  if (followerCreatorId === target) return { ok: false, reason: "self_follow" };

  const sb = createServiceRoleClient();

  // Target must be a real, LIVE creator. The FK already guarantees existence;
  // this additionally rejects soft-deleted creators (deleted_at IS NOT NULL).
  const { data: targetRow, error: targetErr } = await sb
    .from("creators")
    .select("id")
    .eq("id", target)
    .is("deleted_at", null)
    .maybeSingle();
  if (targetErr) return { ok: false, reason: "error" };
  if (!targetRow) return { ok: false, reason: "target_not_found" };

  // Idempotent insert: ON CONFLICT DO NOTHING, so a double-tap is a no-op
  // success rather than a 23505. The trigger increments the counters.
  const { error: insErr } = await sb.from("follows").upsert(
    { follower_creator_id: followerCreatorId, target_creator_id: target },
    {
      onConflict: "follower_creator_id,target_creator_id",
      ignoreDuplicates: true,
    },
  );
  if (insErr) return { ok: false, reason: "error" };

  const followerCount = await readFollowerCount(sb, target);
  return { ok: true, isFollowing: true, followerCount };
}

export async function unfollowCreator(
  targetCreatorId: string,
): Promise<FollowOutcome> {
  const user = await getUser();
  if (!user) return { ok: false, reason: "auth_required" };

  // ACTOR — derived from the session, never from client input.
  const followerCreatorId = await resolveCreatorId(user.id);
  if (!followerCreatorId) return { ok: false, reason: "no_creator" };

  // TARGET — client-supplied.
  const target = (targetCreatorId ?? "").trim();
  if (!target) return { ok: false, reason: "target_not_found" };

  const sb = createServiceRoleClient();

  // Idempotent delete: removing an edge that isn't there affects 0 rows and is
  // a no-op success. The trigger decrements the counters (floored at 0).
  const { error: delErr } = await sb
    .from("follows")
    .delete()
    .eq("follower_creator_id", followerCreatorId)
    .eq("target_creator_id", target);
  if (delErr) return { ok: false, reason: "error" };

  const followerCount = await readFollowerCount(sb, target);
  return { ok: true, isFollowing: false, followerCount };
}

// Follow-status read for a (viewer, target) pair. The viewer is resolved from
// the session user id (NEVER client input); an unclaimed or anon viewer simply
// isn't following anyone, so this returns false rather than erroring.
//
// Designed to fold into the profile page's existing Promise.all (zero extra
// round trip): call getFollowStatus(currentUser?.userId ?? null,
// profile.creator_id) alongside the other parallel profile queries.
//
// `follows` has two FKs to `creators` (follower + target), which makes a
// PostgREST embed ambiguous — so we reuse resolveCreatorId to get the viewer's
// creator id, then do one unambiguous indexed PK probe on follows.
export async function getFollowStatus(
  viewerUserId: string | null,
  targetCreatorId: string,
): Promise<boolean> {
  if (!viewerUserId || !targetCreatorId) return false;
  const followerCreatorId = await resolveCreatorId(viewerUserId);
  if (!followerCreatorId) return false;
  if (followerCreatorId === targetCreatorId) return false; // can't follow self
  const sb = createServiceRoleClient();
  const { data } = await sb
    .from("follows")
    .select("target_creator_id")
    .eq("follower_creator_id", followerCreatorId)
    .eq("target_creator_id", targetCreatorId)
    .limit(1);
  return !!(data && data.length > 0);
}

// What the Follow button needs to render, resolved server-side in ONE pass so
// the button is correct on first paint and needs no round trip on click:
//   "anon"       → viewer logged out (click → sign-in). Fires ZERO queries.
//   "no_creator" → logged in but no claimed creator (click → /onboarding/handle).
//                  Fires one resolveCreatorId (returns null); no follows probe.
//   "ready"      → claimed creator; isFollowing reflects the live edge.
// Built to drop into the profile page's existing Promise.all (no waterfall).
export type FollowState = "anon" | "no_creator" | "ready";

export async function getViewerFollowContext(
  viewerUserId: string | null,
  targetCreatorId: string,
): Promise<{ followState: FollowState; isFollowing: boolean }> {
  if (!viewerUserId) return { followState: "anon", isFollowing: false };
  const followerCreatorId = await resolveCreatorId(viewerUserId);
  if (!followerCreatorId) return { followState: "no_creator", isFollowing: false };
  // Own creator — the page hides the button via isOwner; never self-following.
  if (followerCreatorId === targetCreatorId) {
    return { followState: "ready", isFollowing: false };
  }
  const sb = createServiceRoleClient();
  const { data } = await sb
    .from("follows")
    .select("target_creator_id")
    .eq("follower_creator_id", followerCreatorId)
    .eq("target_creator_id", targetCreatorId)
    .limit(1);
  return { followState: "ready", isFollowing: !!(data && data.length > 0) };
}
