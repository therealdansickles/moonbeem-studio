import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { PUBLICLY_READABLE_FAN_EDIT_STATUSES } from "@/lib/fan-edits/status";

export type CastMember = {
  name: string;
  character?: string | null;
  order?: number | null;
  profile_path?: string | null;
};

export type CrewMember = {
  name: string;
  job: string;
  department?: string | null;
  profile_path?: string | null;
};

export type Title = {
  id: string;
  slug: string;
  title: string;
  year: number | null;
  distributor: string | null;
  poster_url: string | null;
  synopsis: string | null;
  runtime_min: number | null;
  director: string | null;
  starring_csv: string | null;
  external_watch_url: string | null;
  theatrical_release_start: string | null;
  is_active: boolean;
  is_public: boolean;
  is_featured: boolean;
  partner_id: string | null;
  cast_members: CastMember[] | null;
  crew: CrewMember[] | null;
};

const WRITING_JOBS = new Set([
  "Writer",
  "Screenplay",
  "Story",
  "Author",
  "Co-Writer",
  "Novel",
]);

const COMPOSER_JOBS = new Set([
  "Original Music Composer",
  "Music",
  "Composer",
  "Music Composer",
  "Score",
]);

const CINEMATOGRAPHER_JOBS = new Set([
  "Director of Photography",
  "Cinematography",
]);

const EDITOR_JOBS = new Set(["Editor"]);

function uniqueNames(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of names) {
    const key = n.trim();
    if (!key) continue;
    const k = key.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(key);
  }
  return out;
}

function namesByJob(
  crew: CrewMember[] | null,
  jobs: Set<string>,
): string[] {
  if (!crew) return [];
  return uniqueNames(crew.filter((c) => jobs.has(c.job)).map((c) => c.name));
}

export function getDirectors(crew: CrewMember[] | null): string[] {
  if (!crew) return [];
  return uniqueNames(
    crew.filter((c) => c.job === "Director").map((c) => c.name),
  );
}

export function getWriters(crew: CrewMember[] | null): string[] {
  return namesByJob(crew, WRITING_JOBS);
}

export function getCinematographers(crew: CrewMember[] | null): string[] {
  return namesByJob(crew, CINEMATOGRAPHER_JOBS);
}

export function getEditors(crew: CrewMember[] | null): string[] {
  return namesByJob(crew, EDITOR_JOBS);
}

export function getComposers(crew: CrewMember[] | null): string[] {
  return namesByJob(crew, COMPOSER_JOBS);
}

export function getTopCast(
  cast: CastMember[] | null,
  limit = 5,
): string[] {
  if (!cast) return [];
  const sorted = cast
    .slice()
    .sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
  return uniqueNames(sorted.map((c) => c.name)).slice(0, limit);
}

export type SearchResult = {
  id: string;
  slug: string;
  title: string;
  poster_url: string | null;
  year: number | null;
  distributor: string | null;
  is_active: boolean;
  is_featured: boolean;
  rank: number;
};

export async function searchTitles(
  query: string,
  maxResults = 8,
): Promise<SearchResult[]> {
  if (!query || query.trim().length < 2) return [];
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("search_titles", {
    query: query.trim(),
    max_results: maxResults,
  });
  if (error || !data) return [];
  return data as SearchResult[];
}

export type PersonSearchResult = {
  id: string;
  slug: string;
  title: string;
  poster_url: string | null;
  year: number | null;
  distributor: string | null;
  is_active: boolean;
  is_featured: boolean;
  role_in_film: string | null;
};

export async function searchTitlesByPerson(
  personName: string,
  maxResults = 60,
): Promise<PersonSearchResult[]> {
  const trimmed = personName.trim();
  if (!trimmed) return [];
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("search_titles_by_person", {
    person_name: trimmed,
    max_results: maxResults,
  });
  if (error || !data) return [];
  return data as PersonSearchResult[];
}

export async function getFeaturedTitles(): Promise<Title[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("titles")
    .select("*")
    .eq("is_featured", true)
    .eq("is_active", true)
    .order("featured_order", { ascending: true });
  if (error || !data) return [];
  return data as Title[];
}

// Comprehensive catalog of all films on Moonbeem — feeds the
// homepage "All Films" carousel below Recent Remixes. Filters on
// media_type='movie' to exclude TMDB-imported TV rows from the
// catalog (today's 11 rows are all movies; the filter future-
// proofs against TV bleed-in).
//
// When the title_type column ships with the manual title creation
// flow, swap the filter to title_type='movie' — that's the
// canonical content-type taxonomy (movie | tv_series | tv_episode
// | fashion_show | campaign | runway | performance). media_type
// stays as the TMDB-import audit field. (followup queued)
//
// Featured titles intentionally appear in BOTH Featured and All
// Films — Featured is editorial curation, All Films is
// comprehensive coverage. Same posters in two carousels.
//
// Service-role client matches the convention used by the partner-
// catalog page; the homepage page.tsx fans out reads in parallel
// alongside getFeaturedTitles + getRecentFanEdits + getMarqueePartners.
export async function getAllFilms(): Promise<Title[]> {
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from("titles")
    .select("*")
    .eq("is_public", true)
    .eq("is_active", true)
    .eq("media_type", "movie")
    .eq("is_hidden_from_all_films", false)
    // Pinned rows (allfilms_pin_order NOT NULL, ASC NULLS LAST) take
    // the top slots; the rest fill from created_at DESC. No LIMIT —
    // All Films is the comprehensive "everything" carousel; pinning
    // promotes a small set to the top, never excludes anything.
    .order("allfilms_pin_order", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: false });
  if (error || !data) return [];
  return data as Title[];
}

export type TitleOffer = {
  id: string;
  title_id: string;
  offer_type: "theatrical" | "streaming" | "rent" | "buy";
  provider: string | null;
  provider_url: string | null;
  provider_logo_url: string | null;
  price_usd: number | null;
  region_code: string;
  is_active: boolean;
};

export async function getTitleBySlug(slug: string): Promise<Title | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("titles")
    .select("*")
    .eq("slug", slug)
    .maybeSingle();
  if (error || !data) return null;
  return data as Title;
}

export async function getActiveOffersForTitle(
  titleId: string,
): Promise<TitleOffer[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("title_offers")
    .select("*")
    .eq("title_id", titleId);
  if (error || !data) return [];
  const order: Record<TitleOffer["offer_type"], number> = {
    theatrical: 0,
    streaming: 1,
    rent: 2,
    buy: 3,
  };
  const offers = data as TitleOffer[];
  return [...offers].sort(
    (a, b) => order[a.offer_type] - order[b.offer_type],
  );
}

export type Clip = {
  id: string;
  title_id: string;
  file_url: string | null;
  thumbnail_url: string | null;
  label: string | null;
  duration_seconds: number | null;
  file_size_bytes: number | null;
  content_type: string | null;
  display_order: number;
};

export type Still = {
  id: string;
  title_id: string;
  file_url: string | null;
  thumbnail_url: string | null;
  alt_text: string | null;
  photographer_credit: string | null;
  width: number | null;
  height: number | null;
  file_size_bytes: number | null;
  display_order: number;
};

export async function getActiveClipsForTitle(titleId: string): Promise<Clip[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("clips")
    .select(
      "id, title_id, file_url, thumbnail_url, label, duration_seconds, file_size_bytes, content_type, display_order",
    )
    .eq("title_id", titleId)
    .is("deleted_at", null)
    .order("display_order", { ascending: true });
  if (error || !data) return [];
  return data as Clip[];
}

export async function getActiveStillsForTitle(
  titleId: string,
): Promise<Still[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("stills")
    .select(
      "id, title_id, file_url, thumbnail_url, alt_text, photographer_credit, width, height, file_size_bytes, display_order",
    )
    .eq("title_id", titleId)
    .is("deleted_at", null)
    .order("display_order", { ascending: true });
  if (error || !data) return [];
  return data as Still[];
}

export type FanEdit = {
  id: string;
  title_id: string;
  platform: "tiktok" | "instagram" | "youtube" | "twitter";
  embed_url: string;
  caption: string | null;
  creator_handle_displayed: string | null;
  // moonbeem_handle from the linked stub or claimed creator. Null
  // when fan_edits.creator_id is null (handful of legacy @anon
  // rows). Prefer this for clickable bylines; fall back to
  // creator_handle_displayed for display when null.
  creator_moonbeem_handle: string | null;
  display_order: number;
  is_active: boolean;
  // Visual-metadata fields populated by the view-tracking pipeline
  // (Stage B1, 2026-05-07). Null on rows that haven't been refreshed
  // since the new extractor shipped — UI should render a skeleton.
  thumbnail_url: string | null;
  duration_seconds: number | null;
  aspect_ratio: string | null;
  // Engagement count + ingest order — used for view-count-DESC sort
  // and arrow-nav ordering in FanEditsTab/FanEditModal (Stage B2).
  view_count: number;
  created_at: string;
};

type FanEditRow = {
  id: string;
  title_id: string;
  platform: "tiktok" | "instagram" | "youtube" | "twitter";
  embed_url: string;
  caption: string | null;
  creator_handle_displayed: string | null;
  creator_id: string | null;
  display_order: number;
  is_active: boolean;
  thumbnail_url: string | null;
  duration_seconds: number | null;
  aspect_ratio: string | null;
  view_count: number | null;
  created_at: string;
};

// Two-query merge — embedding `creators` directly via PostgREST FK
// would fail RLS (creators has no SELECT policy; only public_creators
// is grant-readable). Fetch fan_edits first, then look up the
// moonbeem_handle for each distinct creator_id from public_creators.
export async function getActiveFanEditsForTitle(
  titleId: string,
): Promise<FanEdit[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("fan_edits")
    .select(
      "id, title_id, platform, embed_url, caption, creator_handle_displayed, creator_id, display_order, is_active, thumbnail_url, duration_seconds, aspect_ratio, view_count, created_at",
    )
    .eq("title_id", titleId);
  if (error || !data) return [];
  const rows = data as FanEditRow[];

  const creatorIds = Array.from(
    new Set(rows.map((r) => r.creator_id).filter((id): id is string => !!id)),
  );
  const handleById = new Map<string, string>();
  if (creatorIds.length > 0) {
    const { data: creators } = await supabase
      .from("public_creators")
      .select("id, moonbeem_handle")
      .in("id", creatorIds);
    for (const c of (creators ?? []) as Array<{
      id: string;
      moonbeem_handle: string;
    }>) {
      handleById.set(c.id, c.moonbeem_handle);
    }
  }

  // Sort view_count DESC, ties broken by created_at DESC. This is the
  // ordering used by the thumbnail grid and modal arrow-nav (Stage B2).
  // Most-watched edit appears first regardless of platform.
  return rows
    .map((r) => ({
      id: r.id,
      title_id: r.title_id,
      platform: r.platform,
      embed_url: r.embed_url,
      caption: r.caption,
      creator_handle_displayed: r.creator_handle_displayed,
      creator_moonbeem_handle: r.creator_id
        ? (handleById.get(r.creator_id) ?? null)
        : null,
      display_order: r.display_order,
      is_active: r.is_active,
      thumbnail_url: r.thumbnail_url,
      duration_seconds: r.duration_seconds,
      aspect_ratio: r.aspect_ratio,
      view_count: r.view_count ?? 0,
      created_at: r.created_at,
    }))
    .sort((a, b) => {
      if (b.view_count !== a.view_count) return b.view_count - a.view_count;
      return b.created_at.localeCompare(a.created_at);
    });
}

export type FanEditWithTitle = {
  id: string;
  title_id: string;
  creator_handle: string;
  creator_handle_displayed: string | null;
  creator_moonbeem_handle: string | null;
  platform: "tiktok" | "instagram" | "youtube" | "twitter";
  embed_url: string;
  thumbnail_url: string | null;
  title_slug: string;
  title_name: string;
  title_poster_url: string;
  created_at: string;
};

type FanEditJoinRow = {
  id: string;
  title_id: string;
  platform: "tiktok" | "instagram" | "youtube" | "twitter";
  embed_url: string;
  thumbnail_url: string | null;
  creator_handle_displayed: string | null;
  creator_id: string | null;
  created_at: string;
  titles: {
    slug: string;
    title: string;
    poster_url: string | null;
    is_active: boolean;
  } | null;
};

export async function getRecentFanEdits(
  limit = 12,
): Promise<FanEditWithTitle[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("fan_edits")
    .select(
      "id, title_id, platform, embed_url, thumbnail_url, creator_handle_displayed, creator_id, created_at, titles!inner(slug, title, poster_url, is_active)",
    )
    .eq("is_active", true)
    .in("verification_status", PUBLICLY_READABLE_FAN_EDIT_STATUSES)
    .is("deleted_at", null)
    .eq("is_hidden_from_recent", false)
    .eq("titles.is_active", true)
    // Pinned rows (recent_pin_order NOT NULL, ASC NULLS LAST) take
    // the top slots; the rest fill from created_at DESC. The 12-row
    // LIMIT applies after the combined sort, so a pinned set of N
    // displaces the N oldest items that would otherwise have shown.
    .order("recent_pin_order", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error || !data) return [];
  const rows = (data as unknown as FanEditJoinRow[]).filter(
    (r) => r.titles && r.titles.poster_url,
  );

  const creatorIds = Array.from(
    new Set(rows.map((r) => r.creator_id).filter((id): id is string => !!id)),
  );
  const handleById = new Map<string, string>();
  if (creatorIds.length > 0) {
    const { data: creators } = await supabase
      .from("public_creators")
      .select("id, moonbeem_handle")
      .in("id", creatorIds);
    for (const c of (creators ?? []) as Array<{
      id: string;
      moonbeem_handle: string;
    }>) {
      handleById.set(c.id, c.moonbeem_handle);
    }
  }

  return rows.map((r) => {
    const moonbeemHandle = r.creator_id
      ? (handleById.get(r.creator_id) ?? null)
      : null;
    return {
      id: r.id,
      title_id: r.title_id,
      creator_handle:
        moonbeemHandle ?? r.creator_handle_displayed ?? "anon",
      creator_handle_displayed: r.creator_handle_displayed,
      creator_moonbeem_handle: moonbeemHandle,
      platform: r.platform,
      embed_url: r.embed_url,
      thumbnail_url: r.thumbnail_url,
      title_slug: r.titles!.slug,
      title_name: r.titles!.title,
      title_poster_url: r.titles!.poster_url!,
      created_at: r.created_at,
    };
  });
}

// Block 3 user-submission queries. Pending / rejected fan_edits never
// surface on public profiles or title pages (their RLS keeps anon out
// already); these helpers run via service-role for the submitter's
// own /me + the admin queue.
export type UserSubmissionFanEdit = {
  id: string;
  title_id: string;
  title_slug: string;
  title_name: string;
  title_poster_url: string | null;
  platform: "tiktok" | "instagram" | "twitter" | "youtube";
  embed_url: string;
  thumbnail_url: string | null;
  created_at: string;
  rejection_reason: string | null;
  post_id: string | null;
};

async function getUserSubmissionFanEdits(args: {
  userId: string;
  status: "pending" | "rejected";
  limit: number;
}): Promise<UserSubmissionFanEdit[]> {
  const sb = createServiceRoleClient();
  const { data } = await sb
    .from("fan_edits")
    .select(
      "id, title_id, platform, embed_url, thumbnail_url, created_at, rejection_reason, post_id, titles!inner(slug, title, poster_url)",
    )
    .eq("created_by_user_id", args.userId)
    .eq("verification_status", args.status)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(args.limit);
  const rows = (data ?? []) as unknown as Array<{
    id: string;
    title_id: string;
    platform: string;
    embed_url: string;
    thumbnail_url: string | null;
    created_at: string;
    rejection_reason: string | null;
    post_id: string | null;
    titles: {
      slug: string;
      title: string;
      poster_url: string | null;
    } | null;
  }>;
  return rows
    .filter((r) => r.titles)
    .map((r) => ({
      id: r.id,
      title_id: r.title_id,
      title_slug: r.titles!.slug,
      title_name: r.titles!.title,
      title_poster_url: r.titles!.poster_url,
      platform: r.platform as "tiktok" | "instagram" | "twitter" | "youtube",
      embed_url: r.embed_url,
      thumbnail_url: r.thumbnail_url,
      created_at: r.created_at,
      rejection_reason: r.rejection_reason,
      post_id: r.post_id,
    }));
}

export async function getPendingFanEditsForUser(
  userId: string,
  limit = 24,
): Promise<UserSubmissionFanEdit[]> {
  return getUserSubmissionFanEdits({ userId, status: "pending", limit });
}

export async function getRejectedFanEditsForUser(
  userId: string,
  limit = 24,
): Promise<UserSubmissionFanEdit[]> {
  return getUserSubmissionFanEdits({ userId, status: "rejected", limit });
}

export type PendingQueueRow = UserSubmissionFanEdit & {
  submitter_user_id: string;
  submitter_handle: string | null;
  submitter_email: string | null;
};

// Admin queue — FIFO across all pending user submissions.
export async function getPendingFanEditQueue(
  limit = 50,
  offset = 0,
): Promise<PendingQueueRow[]> {
  const sb = createServiceRoleClient();
  const { data } = await sb
    .from("fan_edits")
    .select(
      "id, title_id, platform, embed_url, thumbnail_url, created_at, rejection_reason, post_id, created_by_user_id, titles!inner(slug, title, poster_url)",
    )
    .eq("verification_status", "pending")
    .is("deleted_at", null)
    .not("created_by_user_id", "is", null)
    .order("created_at", { ascending: true })
    .range(offset, offset + limit - 1);
  const rows = (data ?? []) as unknown as Array<{
    id: string;
    title_id: string;
    platform: string;
    embed_url: string;
    thumbnail_url: string | null;
    created_at: string;
    rejection_reason: string | null;
    post_id: string | null;
    created_by_user_id: string;
    titles: {
      slug: string;
      title: string;
      poster_url: string | null;
    } | null;
  }>;
  if (rows.length === 0) return [];
  const userIds = Array.from(new Set(rows.map((r) => r.created_by_user_id)));
  const { data: users } = await sb
    .from("users")
    .select("id, handle, email")
    .in("id", userIds);
  const userMap = new Map(
    (users ?? []).map((u) => [
      u.id as string,
      {
        handle: (u.handle as string | null) ?? null,
        email: (u.email as string | null) ?? null,
      },
    ]),
  );
  return rows
    .filter((r) => r.titles)
    .map((r) => {
      const u = userMap.get(r.created_by_user_id) ?? { handle: null, email: null };
      return {
        id: r.id,
        title_id: r.title_id,
        title_slug: r.titles!.slug,
        title_name: r.titles!.title,
        title_poster_url: r.titles!.poster_url,
        platform: r.platform as "tiktok" | "instagram" | "twitter" | "youtube",
        embed_url: r.embed_url,
        thumbnail_url: r.thumbnail_url,
        created_at: r.created_at,
        rejection_reason: r.rejection_reason,
        post_id: r.post_id,
        submitter_user_id: r.created_by_user_id,
        submitter_handle: u.handle,
        submitter_email: u.email,
      };
    });
}

// Fan edits owned by a single creator across the catalog. Powers the
// "Fan edits" sections on /me and /c/[handle]. Mirrors the
// getRecentFanEdits shape so the card components consume one type.
export async function getFanEditsForCreator(
  creatorId: string,
  options: { limit?: number } = {},
): Promise<FanEditWithTitle[]> {
  const limit = options.limit ?? 24;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("fan_edits")
    .select(
      "id, title_id, platform, embed_url, thumbnail_url, creator_handle_displayed, creator_id, created_at, titles!inner(slug, title, poster_url, is_active)",
    )
    .eq("creator_id", creatorId)
    .eq("is_active", true)
    // Block 3: 'approved' (admin-approved user submissions) and
    // 'auto_verified' (legacy admin imports) are both publicly
    // readable. 'pending' and 'rejected' user-submitted rows stay
    // off /c/[handle] and /me's "Your fan edits" — they're surfaced
    // via dedicated query helpers below.
    .in("verification_status", PUBLICLY_READABLE_FAN_EDIT_STATUSES)
    .is("deleted_at", null)
    .eq("titles.is_active", true)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error || !data) return [];
  const rows = (data as unknown as FanEditJoinRow[]).filter(
    (r) => r.titles && r.titles.poster_url,
  );
  if (rows.length === 0) return [];

  // Resolve the single creator's moonbeem_handle once (all rows
  // share it).
  const { data: creators } = await supabase
    .from("public_creators")
    .select("id, moonbeem_handle")
    .eq("id", creatorId)
    .maybeSingle();
  const moonbeemHandle = (creators?.moonbeem_handle as string | null) ?? null;

  return rows.map((r) => ({
    id: r.id,
    title_id: r.title_id,
    creator_handle: moonbeemHandle ?? r.creator_handle_displayed ?? "anon",
    creator_handle_displayed: r.creator_handle_displayed,
    creator_moonbeem_handle: moonbeemHandle,
    platform: r.platform,
    embed_url: r.embed_url,
    thumbnail_url: r.thumbnail_url,
    title_slug: r.titles!.slug,
    title_name: r.titles!.title,
    title_poster_url: r.titles!.poster_url!,
    created_at: r.created_at,
  }));
}

// Trending fan edits — top N by view-count delta over the past 24h.
// Uses existing view_tracking_snapshots data (no new schema, no new
// cron, no first-run NULL trap). Snapshots are written by the
// view-tracking Edge Function every ~20h per fan_edit; 39% of
// active fan_edits have at least one snapshot from ≥24h ago as of
// the initial deploy, growing as the cron continues to populate
// history.
//
// Algorithm:
//   1. Fetch all snapshots for active fan_edits in a single round
//      trip. 847 rows total today — well under any limit.
//   2. Group by fan_edit_id: pick the LATEST snapshot and the
//      most-recent snapshot ≤24h ago.
//   3. Rows with BOTH a latest and a 24h-prior snapshot get a
//      delta. Rows with only a latest (recently ingested, no
//      history) are excluded — they're noise for a "trending"
//      ranking.
//   4. Order by delta DESC, limit N, then hydrate with title +
//      creator handle joins to match FanEditWithTitle shape.
//
// Service-role client matches the partner-catalog convention; also
// view_tracking_snapshots has no public SELECT policy.
export async function getTrendingFanEdits(
  limit = 12,
): Promise<FanEditWithTitle[]> {
  const supabase = createServiceRoleClient();

  // 1. Active, undeleted, verified fan_edits with the standard
  //    filters used by getRecentFanEdits. The view-tracking-status
  //    filter is critical — deleted/private/dead rows aren't
  //    trending material.
  const { data: feActive } = await supabase
    .from("fan_edits")
    .select("id")
    .eq("is_active", true)
    .in("verification_status", PUBLICLY_READABLE_FAN_EDIT_STATUSES)
    .eq("view_tracking_status", "active")
    .is("deleted_at", null);
  const activeIds = (feActive ?? []).map((r) => r.id as string);
  if (activeIds.length === 0) return [];

  // 2. All snapshots for those fan_edits, oldest first so we can
  //    walk the array and "last wins" for the latest pointer.
  const { data: allSnaps } = await supabase
    .from("view_tracking_snapshots")
    .select("fan_edit_id, view_count, captured_at")
    .in("fan_edit_id", activeIds)
    .order("captured_at", { ascending: true });

  const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const latestByFe = new Map<string, { view_count: number; captured_at: string }>();
  const oldByFe = new Map<string, { view_count: number; captured_at: string }>();
  for (const s of allSnaps ?? []) {
    const id = s.fan_edit_id as string;
    const snap = {
      view_count: (s.view_count as number | null) ?? 0,
      captured_at: s.captured_at as string,
    };
    latestByFe.set(id, snap);
    if (snap.captured_at <= cutoff24h) oldByFe.set(id, snap);
  }

  // 3. Compute deltas only for fan_edits with BOTH latest and ≥24h
  //    ago snapshots. INNER JOIN semantics: rows without coverage
  //    are skipped entirely, never padded with zeros.
  const ranked: { id: string; delta: number }[] = [];
  for (const id of activeIds) {
    const latest = latestByFe.get(id);
    const old = oldByFe.get(id);
    if (!latest || !old) continue;
    ranked.push({ id, delta: latest.view_count - old.view_count });
  }
  ranked.sort((a, b) => b.delta - a.delta);
  const topIds = ranked.slice(0, limit).map((r) => r.id);
  if (topIds.length === 0) return [];

  // 4. Hydrate to FanEditWithTitle shape — same JOIN pattern as
  //    getRecentFanEdits. Service-role bypasses fan_edits and
  //    titles RLS; both have public SELECT policies anyway but
  //    we stay on service-role for consistency with this function's
  //    snapshot read.
  const { data: hydrated } = await supabase
    .from("fan_edits")
    .select(
      "id, title_id, platform, embed_url, thumbnail_url, creator_handle_displayed, creator_id, created_at, titles!inner(slug, title, poster_url, is_active)",
    )
    .in("id", topIds)
    .eq("titles.is_active", true);
  const rowsRaw = (hydrated ?? []) as unknown as FanEditJoinRow[];
  const rows = rowsRaw.filter((r) => r.titles && r.titles.poster_url);

  // Preserve the delta-ranked order (hydrate query loses it).
  const orderIndex = new Map(topIds.map((id, i) => [id, i]));
  rows.sort(
    (a, b) =>
      (orderIndex.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
      (orderIndex.get(b.id) ?? Number.MAX_SAFE_INTEGER),
  );

  // Creator handle map (mirrors getRecentFanEdits).
  const creatorIds = Array.from(
    new Set(rows.map((r) => r.creator_id).filter((id): id is string => !!id)),
  );
  const handleById = new Map<string, string>();
  if (creatorIds.length > 0) {
    const { data: creators } = await supabase
      .from("public_creators")
      .select("id, moonbeem_handle")
      .in("id", creatorIds);
    for (const c of (creators ?? []) as Array<{
      id: string;
      moonbeem_handle: string;
    }>) {
      handleById.set(c.id, c.moonbeem_handle);
    }
  }

  return rows.map((r) => {
    const moonbeemHandle = r.creator_id
      ? (handleById.get(r.creator_id) ?? null)
      : null;
    return {
      id: r.id,
      title_id: r.title_id,
      creator_handle:
        moonbeemHandle ?? r.creator_handle_displayed ?? "anon",
      creator_handle_displayed: r.creator_handle_displayed,
      creator_moonbeem_handle: moonbeemHandle,
      platform: r.platform,
      embed_url: r.embed_url,
      thumbnail_url: r.thumbnail_url,
      title_slug: r.titles!.slug,
      title_name: r.titles!.title,
      title_poster_url: r.titles!.poster_url!,
      created_at: r.created_at,
    };
  });
}
