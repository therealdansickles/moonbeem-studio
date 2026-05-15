import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import {
  ALLOWED_SOCIAL_PLATFORMS,
  type SocialPlatform,
} from "@/lib/socials/handle";

export type ProfileLink = { label: string; url: string };

export type VerifiedSocial = {
  platform: SocialPlatform;
  handle: string;
  verified_at: string;
};

export type Profile = {
  creator_id: string;
  user_id: string | null;
  handle: string;
  display_name: string | null;
  bio: string | null;
  avatar_url: string | null;
  links: ProfileLink[];
  // Verified socials with display_on_profile=true. Empty for stubs
  // and for users who toggled all of theirs off.
  verified_socials: VerifiedSocial[];
  is_stub: boolean;
};

export type TopTitle = {
  id: string;
  user_id: string;
  title_id: string;
  position: number;
  title: {
    id: string;
    slug: string;
    title: string;
    poster_url: string | null;
  };
};

type RawLink = { label?: unknown; url?: unknown };

function normalizeLinks(raw: unknown): ProfileLink[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry): ProfileLink | null => {
      if (!entry || typeof entry !== "object") return null;
      const e = entry as RawLink;
      const label = typeof e.label === "string" ? e.label.trim() : "";
      const url = typeof e.url === "string" ? e.url.trim() : "";
      if (!label || !url) return null;
      return { label, url };
    })
    .filter((v): v is ProfileLink => v !== null)
    .slice(0, 5);
}

// Pull verified, display-on-profile socials for a creator. Service-
// role read because creator_socials has RLS with no public SELECT
// policy. Scoped to the creator_id we just resolved, and we only
// expose (platform, handle, verified_at) to callers — no
// verification_code or pending state leakage.
async function loadVerifiedSocials(
  creatorId: string,
): Promise<VerifiedSocial[]> {
  const service = createServiceRoleClient();
  const { data } = await service
    .from("creator_socials")
    .select("platform, handle, verified_at, is_verified, display_on_profile")
    .eq("creator_id", creatorId)
    .eq("is_verified", true)
    .eq("display_on_profile", true)
    .not("verified_at", "is", null)
    .not("handle", "is", null);
  if (!data) return [];
  const out: VerifiedSocial[] = [];
  for (const r of data) {
    const platform = r.platform as string;
    if (!(ALLOWED_SOCIAL_PLATFORMS as readonly string[]).includes(platform)) {
      continue;
    }
    const handle = r.handle as string | null;
    const verifiedAt = r.verified_at as string | null;
    if (!handle || !verifiedAt) continue;
    out.push({
      platform: platform as SocialPlatform,
      handle,
      verified_at: verifiedAt,
    });
  }
  // Stable order: platform list order, so the same identity always
  // renders in the same sequence.
  const order = new Map(ALLOWED_SOCIAL_PLATFORMS.map((p, i) => [p, i]));
  out.sort((a, b) => (order.get(a.platform)! - order.get(b.platform)!));
  return out;
}

export async function getProfileByHandle(
  handle: string,
): Promise<Profile | null> {
  const cleaned = handle.trim().toLowerCase();
  if (!cleaned) return null;
  const supabase = await createClient();

  const { data: creator, error: cErr } = await supabase
    .from("public_creators")
    .select("id, user_id, moonbeem_handle, is_stub")
    .eq("moonbeem_handle", cleaned)
    .maybeSingle();
  if (cErr || !creator) return null;

  const creatorId = creator.id as string;
  const userId = (creator.user_id as string | null) ?? null;
  const moonbeemHandle = creator.moonbeem_handle as string;
  const isStub = Boolean(creator.is_stub);

  if (!userId) {
    return {
      creator_id: creatorId,
      user_id: null,
      handle: moonbeemHandle,
      display_name: null,
      bio: null,
      avatar_url: null,
      links: [],
      verified_socials: [],
      is_stub: isStub,
    };
  }

  const [{ data: user }, verifiedSocials] = await Promise.all([
    supabase
      .from("public_profiles")
      .select("display_name, bio, avatar_url, links")
      .eq("id", userId)
      .maybeSingle(),
    loadVerifiedSocials(creatorId),
  ]);

  return {
    creator_id: creatorId,
    user_id: userId,
    handle: moonbeemHandle,
    display_name: (user?.display_name ?? null) as string | null,
    bio: (user?.bio ?? null) as string | null,
    avatar_url: (user?.avatar_url ?? null) as string | null,
    links: normalizeLinks(user?.links),
    verified_socials: verifiedSocials,
    is_stub: isStub,
  };
}

type TopTitleJoinRow = {
  id: string;
  user_id: string;
  title_id: string;
  position: number;
  titles: {
    id: string;
    slug: string;
    title: string;
    poster_url: string | null;
  } | null;
};

export type UnclaimedStub = {
  stubCreatorId: string;
  platform: SocialPlatform;
  socialHandle: string;
  fanEditCount: number;
  thumbnails: string[];
  // Which heuristic matched the stub to the user. 'verified_social'
  // (the stub's social handle matches one the user has already
  // verified — strongest signal) > 'user_handle' (matches the user's
  // Moonbeem handle after underscore-normalization).
  matchType: "verified_social" | "user_handle";
};

// Returns stubs that plausibly belong to `userId` so /me can prompt
// the user to verify the underlying social and claim the edits.
//
// Match rules (per Block 2.5):
//   (a) creator_socials.handle equals users.handle (case-insensitive)
//   (b) lower(replace(cs.handle, '_', '')) equals the same of users.handle
//       — covers "dan_sickles" ↔ "dansickles"
//   (c) cs.handle equals (or normalizes to) any handle on a
//       creator_socials row already verified by this user
//
// Only stubs that have at least one ACTIVE non-deleted fan_edit
// attached are returned — there's no point prompting to claim an
// empty stub. Stubs already soft-deleted are excluded.
//
// Service-role client. The route invokes this from a server component
// after `verifySession`, so the user identity is already bound; we
// just need to bypass RLS on creator_socials + creators.
export async function getUnclaimedStubEditsForUser(
  userId: string,
): Promise<UnclaimedStub[]> {
  const sb = createServiceRoleClient();

  // 1. User's Moonbeem handle.
  const { data: user } = await sb
    .from("users")
    .select("handle")
    .eq("id", userId)
    .maybeSingle();
  const userHandle = (user?.handle as string | null) ?? null;
  if (!userHandle) return [];

  // 2. User's owned creators + their verified socials. We carry the
  // platform alongside the handle — see the comment on the match
  // step below for why.
  const { data: ownedCreators } = await sb
    .from("creators")
    .select("id")
    .eq("user_id", userId)
    .is("deleted_at", null);
  const ownedIds = (ownedCreators ?? []).map((c) => c.id as string);
  type VerifiedPair = { platform: string; handle: string };
  let verifiedPairs: VerifiedPair[] = [];
  if (ownedIds.length > 0) {
    const { data: socials } = await sb
      .from("creator_socials")
      .select("platform, handle")
      .in("creator_id", ownedIds)
      .not("verified_at", "is", null);
    verifiedPairs = (socials ?? [])
      .filter((s) => !!s.handle)
      .map((s) => ({
        platform: s.platform as string,
        handle: s.handle as string,
      }));
  }

  // 3. Normalized candidates per platform. user_handle is platform-
  // agnostic (we know what handle the *human* uses on Moonbeem, not
  // which platforms they live on); verified_social matching is
  // platform-scoped — see match step.
  const normalize = (h: string) =>
    h.toLowerCase().replace(/[_.\s]/g, "");
  const normalizedUserHandle = normalize(userHandle);
  // platform → { exact: Set<lowercase handle>, normalized: Set<normalized handle> }
  const verifiedByPlatform = new Map<
    string,
    { exact: Set<string>; normalized: Set<string> }
  >();
  for (const v of verifiedPairs) {
    const entry =
      verifiedByPlatform.get(v.platform) ??
      { exact: new Set<string>(), normalized: new Set<string>() };
    entry.exact.add(v.handle.toLowerCase());
    entry.normalized.add(normalize(v.handle));
    verifiedByPlatform.set(v.platform, entry);
  }

  // 4. Pull candidate stub socials. We over-fetch (any unverified
  // social on a stub) and filter in JS — the population is small
  // (~111 socials total per recon 2.4).
  const { data: stubSocialsRaw } = await sb
    .from("creator_socials")
    .select("creator_id, platform, handle, creators!inner(id, user_id, is_stub, deleted_at)")
    .eq("creators.is_stub", true)
    .is("creators.user_id", null)
    .is("creators.deleted_at", null);
  const candidates = (stubSocialsRaw ?? []) as Array<{
    creator_id: string;
    platform: string;
    handle: string | null;
  }>;

  // 5. Apply match rules and dedupe by stub_creator_id.
  type Hit = {
    stubCreatorId: string;
    platform: SocialPlatform;
    socialHandle: string;
    matchType: UnclaimedStub["matchType"];
  };
  const hits: Hit[] = [];
  for (const c of candidates) {
    if (!c.handle) continue;
    if (
      !ALLOWED_SOCIAL_PLATFORMS.includes(c.platform as SocialPlatform)
    ) {
      continue;
    }
    const normH = normalize(c.handle);
    let match: UnclaimedStub["matchType"] | null = null;
    // verified_social matching is platform-scoped: @dansickles on
    // Instagram and @dansickles on Twitter could be two different
    // people. Do not loosen this without revisiting the claim flow.
    const platformVerified = verifiedByPlatform.get(c.platform);
    if (
      platformVerified &&
      (platformVerified.exact.has(c.handle.toLowerCase()) ||
        platformVerified.normalized.has(normH))
    ) {
      match = "verified_social";
    } else if (normH === normalizedUserHandle) {
      match = "user_handle";
    }
    if (!match) continue;
    hits.push({
      stubCreatorId: c.creator_id,
      platform: c.platform as SocialPlatform,
      socialHandle: c.handle,
      matchType: match,
    });
  }
  if (hits.length === 0) return [];

  // 6. Count + thumbnail-sample fan_edits per stub. Batch one query.
  const stubIds = Array.from(new Set(hits.map((h) => h.stubCreatorId)));
  const { data: edits } = await sb
    .from("fan_edits")
    .select("id, creator_id, thumbnail_url, created_at")
    .in("creator_id", stubIds)
    .eq("is_active", true)
    .eq("verification_status", "auto_verified")
    .is("deleted_at", null)
    .order("created_at", { ascending: false });
  const byCreator = new Map<
    string,
    { count: number; thumbnails: string[] }
  >();
  for (const e of edits ?? []) {
    const cid = e.creator_id as string;
    const entry = byCreator.get(cid) ?? { count: 0, thumbnails: [] };
    entry.count += 1;
    const thumb = (e.thumbnail_url as string | null) ?? null;
    if (thumb && entry.thumbnails.length < 3) entry.thumbnails.push(thumb);
    byCreator.set(cid, entry);
  }

  // 7. Stitch and prune — drop stubs with zero active edits.
  const out: UnclaimedStub[] = [];
  for (const hit of hits) {
    const counts = byCreator.get(hit.stubCreatorId);
    if (!counts || counts.count === 0) continue;
    out.push({
      stubCreatorId: hit.stubCreatorId,
      platform: hit.platform,
      socialHandle: hit.socialHandle,
      fanEditCount: counts.count,
      thumbnails: counts.thumbnails,
      matchType: hit.matchType,
    });
  }
  // Strongest signal first (verified_social before user_handle),
  // then by edit-count desc.
  out.sort((a, b) => {
    if (a.matchType !== b.matchType) {
      return a.matchType === "verified_social" ? -1 : 1;
    }
    return b.fanEditCount - a.fanEditCount;
  });
  return out;
}

export async function getTopTitlesForUser(
  userId: string,
): Promise<TopTitle[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("user_top_titles")
    .select(
      "id, user_id, title_id, position, titles:title_id(id, slug, title, poster_url)",
    )
    .eq("user_id", userId)
    .order("position", { ascending: true });
  if (error || !data) return [];
  return (data as unknown as TopTitleJoinRow[])
    .filter((r) => r.titles)
    .map((r) => ({
      id: r.id,
      user_id: r.user_id,
      title_id: r.title_id,
      position: r.position,
      title: r.titles!,
    }));
}
