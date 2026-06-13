// Phase 2E.1 — watched count for a public profile. Anon SSR client (the
// watched_titles "public read" RLS policy scopes anon to visibility='public');
// the defensive .eq('visibility','public') is load-bearing for a signed-in
// viewer whose owner-RLS would otherwise ALSO return their own private rows
// (the 1B pattern). Count-only (head:true) — no rows are fetched.

import { getUser } from "@/lib/dal";
import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { chunkedIn } from "@/lib/queries/chunked-in";

export type WatchedItem = {
  id: string;
  title_id: string | null;
  title_slug: string | null;
  title_name: string;
  poster_url: string | null;
  raw_year: number | null;
};

export async function getWatchedCountForCreator(
  creatorId: string,
): Promise<number> {
  const supabase = await createClient();
  const { count } = await supabase
    .from("watched_titles")
    .select("id", { count: "exact", head: true })
    .eq("creator_id", creatorId)
    .eq("visibility", "public");
  return count ?? 0;
}

// Phase 2E.2 — is the given title in the signed-in caller's watched set? (title-
// page toggle initial state — service-role to resolve the creator, anon owner-
// RLS read.) ANY watched row counts (imported-private OR native-public): the
// film is watched either way, so the toggle shows "on" — unlike the star
// control, which hides unattested imports.
export async function getMyWatchedStateForTitle(
  titleId: string,
): Promise<boolean> {
  const user = await getUser();
  if (!user) return false;
  const service = createServiceRoleClient();
  const { data: creator } = await service
    .from("creators")
    .select("id")
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!creator?.id) return false;

  const supabase = await createClient();
  // .limit(1) (not maybeSingle): the (creator_id, title_id) partial unique keeps
  // this <=1, but stay dup-tolerant. Owner-all RLS covers reading own rows.
  const { data: rows } = await supabase
    .from("watched_titles")
    .select("id")
    .eq("creator_id", creator.id as string)
    .eq("title_id", titleId)
    .limit(1);
  return Boolean(rows && rows.length > 0);
}

// Phase 2E.3 — the creator's public watched grid, newest-marked first. Anon SSR
// (defensive visibility='public', the 1B pattern). 2D.1 rules: a MATCHED title
// (title_id NOT NULL) contributes its canonical name + poster regardless of
// is_public/deleted_at; the link (title_slug) is live-only. An unmatched row
// (title_id NULL) renders raw_title (+ raw_year) text. The title join is CHUNKED
// (≤100 ids/call): a creator can have hundreds of watched (Dan: 326) and one
// .in() over all of them would trip the URL-length cap (the 2B.2/2D.3 trap) —
// chunkedIn logs server-side and degrades a failed chunk to text. marked_on is
// the ORDER key only; it is never displayed.
export async function getPublicWatchedForCreator(
  creatorId: string,
): Promise<WatchedItem[]> {
  const supabase = await createClient();
  const { data: rows } = await supabase
    .from("watched_titles")
    .select("id, title_id, raw_title, raw_year")
    .eq("creator_id", creatorId)
    .eq("visibility", "public")
    .order("marked_on", { ascending: false })
    .order("created_at", { ascending: false });
  if (!rows || rows.length === 0) return [];

  const titleIds = [
    ...new Set(
      rows
        .map((r) => r.title_id as string | null)
        .filter((x): x is string => Boolean(x)),
    ),
  ];
  const titleById = new Map<
    string,
    {
      slug: string;
      title: string;
      poster_url: string | null;
      is_public: boolean;
      deleted_at: string | null;
    }
  >();
  if (titleIds.length) {
    const titles = await chunkedIn(titleIds, "watched.getPublic", (chunk) =>
      supabase
        .from("titles")
        .select("id, slug, title, poster_url, is_public, deleted_at")
        .in("id", chunk),
    );
    for (const t of titles) {
      titleById.set(t.id as string, {
        slug: t.slug as string,
        title: t.title as string,
        poster_url: (t.poster_url as string | null) ?? null,
        is_public: t.is_public as boolean,
        deleted_at: (t.deleted_at as string | null) ?? null,
      });
    }
  }

  return rows.map((r) => {
    const t = r.title_id ? titleById.get(r.title_id as string) : undefined;
    // Link only when live; a matched-but-non-live title renders as text + poster.
    const titleSlug = t && t.is_public && t.deleted_at == null ? t.slug : null;
    return {
      id: r.id as string,
      title_id: (r.title_id as string | null) ?? null,
      title_slug: titleSlug,
      title_name: t?.title ?? (r.raw_title as string | null) ?? "Untitled",
      poster_url: t?.poster_url ?? null,
      raw_year: (r.raw_year as number | null) ?? null,
    };
  });
}
