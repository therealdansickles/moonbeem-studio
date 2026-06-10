// Phase 1B — public reviews for a title (a review = a diary_entries row with
// non-empty review_text). Read under the anon SSR client; the diary_entries
// "public read" RLS policy (visibility='public') scopes anon to public rows.
//
// Byline merge mirrors getActiveFanEditsForTitle (titles.ts:470-473) +
// getProfileByHandle (profiles.ts:134-141): creators has no anon SELECT, so
// resolve moonbeem_handle via the public_creators view, then display_name /
// avatar via public_profiles keyed by the creator's user_id.

import { createClient } from "@/lib/supabase/server";

export type PublicReview = {
  id: string;
  creator_id: string;
  handle: string | null;
  display_name: string | null;
  avatar_url: string | null;
  rating: number | null;
  watched_on: string;
  review_text: string;
  contains_spoilers: boolean;
  created_at: string;
};

export async function getPublicReviewsForTitle(
  titleId: string,
  limit = 20,
): Promise<PublicReview[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("diary_entries")
    .select(
      "id, creator_id, rating, watched_on, review_text, contains_spoilers, created_at",
    )
    .eq("title_id", titleId)
    .eq("visibility", "public")
    .not("review_text", "is", null)
    .neq("review_text", "") // a review = NON-EMPTY review_text
    .order("watched_on", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error || !data || data.length === 0) return [];

  // Byline: creator_id -> moonbeem_handle (+user_id) via public_creators,
  // then user_id -> display_name/avatar via public_profiles.
  const creatorIds = [...new Set(data.map((r) => r.creator_id as string))];
  const { data: creators } = await supabase
    .from("public_creators")
    .select("id, user_id, moonbeem_handle")
    .in("id", creatorIds);
  const creatorById = new Map(
    (creators ?? []).map((c) => [
      c.id as string,
      {
        handle: (c.moonbeem_handle as string | null) ?? null,
        userId: (c.user_id as string | null) ?? null,
      },
    ]),
  );

  const userIds = [
    ...new Set(
      (creators ?? [])
        .map((c) => c.user_id as string | null)
        .filter((x): x is string => Boolean(x)),
    ),
  ];
  const { data: profiles } = userIds.length
    ? await supabase
        .from("public_profiles")
        .select("id, display_name, avatar_url")
        .in("id", userIds)
    : { data: [] as { id: string; display_name: string | null; avatar_url: string | null }[] };
  const profileByUser = new Map(
    (profiles ?? []).map((p) => [
      p.id as string,
      {
        display_name: (p.display_name as string | null) ?? null,
        avatar_url: (p.avatar_url as string | null) ?? null,
      },
    ]),
  );

  return data.map((r) => {
    const c = creatorById.get(r.creator_id as string);
    const prof = c?.userId ? profileByUser.get(c.userId) : undefined;
    return {
      id: r.id as string,
      creator_id: r.creator_id as string,
      handle: c?.handle ?? null,
      display_name: prof?.display_name ?? null,
      avatar_url: prof?.avatar_url ?? null,
      rating: r.rating != null ? Number(r.rating) : null,
      watched_on: r.watched_on as string,
      review_text: r.review_text as string,
      contains_spoilers: Boolean(r.contains_spoilers),
      created_at: r.created_at as string,
    };
  });
}
