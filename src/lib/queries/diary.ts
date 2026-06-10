// Phase 1C — diary reads. A diary entry = any diary_entries row; a review is
// one with non-empty review_text. Public profile reads go through the anon SSR
// client (the diary_entries "public read" RLS policy scopes anon to
// visibility='public'); the /me owner view reads all visibilities via the
// service-role client. Titles are batch-joined via .in() (not an embedded FK)
// so unmatched rows (title_id NULL) fall back to raw_title text.

import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import type { SupabaseClient } from "@supabase/supabase-js";

export type DiaryEntry = {
  id: string;
  title_id: string | null;
  title_slug: string | null;
  title_name: string;
  poster_url: string | null;
  watched_on: string;
  rating: number | null;
  rewatch: boolean;
  has_review: boolean;
  visibility: string;
  created_at: string;
};

type DiaryRow = {
  id: string;
  title_id: string | null;
  raw_title: string | null;
  watched_on: string;
  rating: number | string | null;
  rewatch: boolean | null;
  review_text: string | null;
  visibility: string;
  created_at: string;
};

const SELECT =
  "id, title_id, raw_title, watched_on, rating, rewatch, review_text, visibility, created_at";

async function mapRows(
  supabase: SupabaseClient,
  rows: DiaryRow[],
  publicTitlesOnly: boolean,
): Promise<DiaryEntry[]> {
  const titleIds = [
    ...new Set(rows.map((r) => r.title_id).filter((x): x is string => Boolean(x))),
  ];
  const titleById = new Map<
    string,
    { slug: string; title: string; poster_url: string | null }
  >();
  if (titleIds.length) {
    // The public profile must never surface a hidden (is_public=false) title's
    // name/poster/slug; those rows fall back to a neutral "Untitled".
    const base = supabase
      .from("titles")
      .select("id, slug, title, poster_url")
      .in("id", titleIds);
    const { data: titles } = await (publicTitlesOnly
      ? base.eq("is_public", true)
      : base);
    for (const t of titles ?? []) {
      titleById.set(t.id as string, {
        slug: t.slug as string,
        title: t.title as string,
        poster_url: (t.poster_url as string | null) ?? null,
      });
    }
  }

  return rows.map((r) => {
    const t = r.title_id ? titleById.get(r.title_id) : undefined;
    return {
      id: r.id,
      title_id: r.title_id ?? null,
      title_slug: t?.slug ?? null,
      title_name: t?.title ?? r.raw_title ?? "Untitled",
      poster_url: t?.poster_url ?? null,
      watched_on: r.watched_on,
      rating: r.rating != null ? Number(r.rating) : null,
      rewatch: Boolean(r.rewatch),
      has_review:
        typeof r.review_text === "string" && r.review_text.trim().length > 0,
      visibility: r.visibility,
      created_at: r.created_at,
    };
  });
}

// Public diary for a creator's profile — anon SSR client, visibility='public'
// (defensive .eq even though RLS enforces it; load-bearing for a signed-in
// viewer whose owner-RLS would otherwise return their own private rows).
export async function getPublicDiaryForCreator(
  creatorId: string,
  limit = 20,
): Promise<DiaryEntry[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("diary_entries")
    .select(SELECT)
    .eq("creator_id", creatorId)
    .eq("visibility", "public")
    .order("watched_on", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error || !data || data.length === 0) return [];
  return mapRows(supabase, data as unknown as DiaryRow[], true);
}

// Owner view (/me/diary) — service-role, all visibilities, newest first.
export async function getMyDiaryEntries(
  creatorId: string,
): Promise<DiaryEntry[]> {
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from("diary_entries")
    .select(SELECT)
    .eq("creator_id", creatorId)
    .order("watched_on", { ascending: false })
    .order("created_at", { ascending: false });
  if (error || !data || data.length === 0) return [];
  return mapRows(supabase, data as unknown as DiaryRow[], false);
}
