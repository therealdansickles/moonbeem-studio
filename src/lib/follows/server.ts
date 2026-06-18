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
import { createClient } from "@/lib/supabase/server";
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

// ============================================================================
// Step 4/5: public follower / following list reads.
//
// PUBLIC reads via the anon SSR client (createClient), matching
// getProfileByHandle. follows is public-read RLS; public_creators and
// public_profiles are anon-readable. No service-role needed.
//
// `follows` has two FKs to creators, so a PostgREST embed is ambiguous — we do
// a batched MULTI-STEP read (no embed): (1) page the follows edge ids ordered
// newest-first, (2) .in() public_creators for handle/user_id/is_stub (the view
// carries no name/avatar), (3) .in() public_profiles for name/avatar by the
// non-null user_ids. Stubs (user_id NULL) have no public_profiles row → null
// name/avatar; they are NOT dropped (AvatarCircle renders initials).
//
// THE ORDERING GOTCHA: the .in() reads return rows in arbitrary order. The
// stitch iterates the step-1 ORDERED id list and looks each up in keyed maps,
// so the created_at-desc order survives. A naive map over the .in() results
// would lose it.
// ============================================================================
export type CreatorRow = {
  creatorId: string;
  handle: string;
  displayName: string | null;
  avatarUrl: string | null;
  isStub: boolean;
};

// Resolve an ORDERED list of creator ids into display rows, preserving order.
async function hydrateCreatorRows(
  supabase: SupabaseClient,
  orderedIds: string[],
): Promise<CreatorRow[]> {
  if (orderedIds.length === 0) return [];

  // Step 2 — handle / user_id / is_stub from the anon-readable view.
  const { data: creators } = await supabase
    .from("public_creators")
    .select("id, moonbeem_handle, user_id, is_stub")
    .in("id", orderedIds);
  const byId = new Map<
    string,
    { handle: string; userId: string | null; isStub: boolean }
  >();
  for (const c of creators ?? []) {
    byId.set(c.id as string, {
      handle: c.moonbeem_handle as string,
      userId: (c.user_id as string | null) ?? null,
      isStub: Boolean(c.is_stub),
    });
  }

  // Step 3 — name / avatar from public_profiles, keyed by user_id (claimed
  // creators only; stubs have no user and stay null).
  const userIds = Array.from(
    new Set(
      Array.from(byId.values())
        .map((c) => c.userId)
        .filter((u): u is string => !!u),
    ),
  );
  const profileByUserId = new Map<
    string,
    { displayName: string | null; avatarUrl: string | null }
  >();
  if (userIds.length > 0) {
    const { data: profiles } = await supabase
      .from("public_profiles")
      .select("id, display_name, avatar_url")
      .in("id", userIds);
    for (const p of profiles ?? []) {
      profileByUserId.set(p.id as string, {
        displayName: (p.display_name as string | null) ?? null,
        avatarUrl: (p.avatar_url as string | null) ?? null,
      });
    }
  }

  // Step 4 — stitch in the ORIGINAL ordered-id order (NOT the .in() order).
  const rows: CreatorRow[] = [];
  for (const id of orderedIds) {
    const c = byId.get(id);
    if (!c) continue; // creator soft-deleted / not in the view → drop silently
    const prof = c.userId ? profileByUserId.get(c.userId) : undefined;
    rows.push({
      creatorId: id,
      handle: c.handle,
      displayName: prof?.displayName ?? null,
      avatarUrl: prof?.avatarUrl ?? null,
      isStub: c.isStub,
    });
  }
  return rows;
}

// Followers of X: rows where target_creator_id = X, the FOLLOWER hydrated.
// Newest-follow-first. Served by idx_follows_target.
export async function getFollowersOfCreator(
  creatorId: string,
  { limit, offset }: { limit: number; offset: number },
): Promise<CreatorRow[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("follows")
    .select("follower_creator_id, created_at")
    .eq("target_creator_id", creatorId)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);
  const orderedIds = (data ?? []).map((r) => r.follower_creator_id as string);
  return hydrateCreatorRows(supabase, orderedIds);
}

// Who X follows: rows where follower_creator_id = X, the TARGET hydrated.
// Newest-follow-first. Served by the follows PK prefix.
export async function getFollowingOfCreator(
  creatorId: string,
  { limit, offset }: { limit: number; offset: number },
): Promise<CreatorRow[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("follows")
    .select("target_creator_id, created_at")
    .eq("follower_creator_id", creatorId)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);
  const orderedIds = (data ?? []).map((r) => r.target_creator_id as string);
  return hydrateCreatorRows(supabase, orderedIds);
}
