// Phase 1C — diary reads. A diary entry = any diary_entries row; a review is
// one with non-empty review_text. Public profile reads go through the anon SSR
// client (the diary_entries "public read" RLS policy scopes anon to
// visibility='public'); the /me owner view reads all visibilities via the
// service-role client. Titles are batch-joined via .in() (not an embedded FK)
// so unmatched rows (title_id NULL) fall back to raw_title text.

import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import type { SupabaseClient } from "@supabase/supabase-js";
import { chunkedIn } from "@/lib/queries/chunked-in";

export type DiaryEntry = {
  id: string;
  title_id: string | null;
  title_slug: string | null;
  title_name: string;
  raw_year: number | null;
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
  raw_year: number | null;
  watched_on: string;
  rating: number | string | null;
  rewatch: boolean | null;
  review_text: string | null;
  visibility: string;
  created_at: string;
};

const SELECT =
  "id, title_id, raw_title, raw_year, watched_on, rating, rewatch, review_text, visibility, created_at";

async function mapRows(
  supabase: SupabaseClient,
  rows: DiaryRow[],
): Promise<DiaryEntry[]> {
  const titleIds = [
    ...new Set(rows.map((r) => r.title_id).filter((x): x is string => Boolean(x))),
  ];
  const titleById = new Map<
    string,
    {
      slug: string;
      title: string;
      poster_url: string | null;
      year: number | null;
      is_public: boolean;
      deleted_at: string | null;
    }
  >();
  if (titleIds.length) {
    // 2D.1: a MATCHED title (title_id NOT NULL) surfaces its canonical name,
    // year, and poster on EVERY surface regardless of is_public/deleted_at —
    // mirroring the Top 12 precedent (getTopTitlesForUser applies no live
    // filter; TitleCard renders the poster unconditionally). Only the LINK
    // (title_slug) stays live-only (is_public AND deleted_at IS NULL), so a
    // non-live matched title shows as name + poster with no /t link. A
    // title_id-NULL row still falls back to raw_title (+ raw_year) text.
    // 2D.3: chunked (≤100 ids/call) — getMyDiaryEntries has no row limit, so a
    // power user's diary can reference hundreds of distinct titles; one .in()
    // over all of them would trip the URL-length cap (the 2B trap).
    const titles = await chunkedIn(titleIds, "diary.mapRows", (chunk) =>
      supabase
        .from("titles")
        .select("id, slug, title, poster_url, year, is_public, deleted_at")
        .in("id", chunk),
    );
    for (const t of titles) {
      titleById.set(t.id as string, {
        slug: t.slug as string,
        title: t.title as string,
        poster_url: (t.poster_url as string | null) ?? null,
        year: (t.year as number | null) ?? null,
        is_public: t.is_public as boolean,
        deleted_at: (t.deleted_at as string | null) ?? null,
      });
    }
  }

  return rows.map((r) => {
    const t = r.title_id ? titleById.get(r.title_id) : undefined;
    // Link only when live; a matched-but-non-live title renders as text.
    const titleSlug =
      t && t.is_public && t.deleted_at == null ? t.slug : null;
    return {
      id: r.id,
      title_id: r.title_id ?? null,
      title_slug: titleSlug,
      title_name: t?.title ?? r.raw_title ?? "Untitled",
      // Canonical year from the matched title (else the row's raw year);
      // unmatched rows keep raw_year. Field stays named raw_year so DiaryRow's
      // text branch needs no change.
      raw_year: t ? t.year ?? r.raw_year ?? null : r.raw_year ?? null,
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
  return mapRows(supabase, data as unknown as DiaryRow[]);
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
  return mapRows(supabase, data as unknown as DiaryRow[]);
}
