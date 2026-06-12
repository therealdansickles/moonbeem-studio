// Phase 1D — list reads. Public reads use the anon SSR client (the user_lists /
// user_list_items "public read" RLS policies scope anon to visibility='public'
// lists); owner reads (/me) use the service-role client. Titles are batch-joined
// via .in(). 2D.1: a MATCHED item (title_id NOT NULL) renders its canonical name
// + poster regardless of is_public/deleted_at (Top 12 precedent); only the link
// (title_slug) stays live-only. An unmatched item (title_id NULL) renders as
// raw_title text (never skipped). List counts include EVERY item; poster strips
// include EVERY matched item's poster, in position order.

import { getUser } from "@/lib/dal";
import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import type { SupabaseClient } from "@supabase/supabase-js";
import { chunkedIn } from "@/lib/queries/chunked-in";

export type ListItem = {
  id: string;
  title_id: string | null;
  title_slug: string | null;
  title_name: string;
  poster_url: string | null;
  position: number;
};

export type PublicListSummary = {
  id: string;
  name: string;
  kind: string; // 'list' | 'watchlist'
  item_count: number;
  posters: string[]; // up to 4 matched-title posters, in position order
};

export type PublicListDetail = {
  id: string;
  name: string;
  description: string | null;
  kind: string;
  item_count: number;
  items: ListItem[];
};

export type MyListSummary = { id: string; name: string; kind: string; item_count: number };
export type MyListDetail = { id: string; name: string; kind: string; description: string | null; items: ListItem[] };

type ItemRow = {
  id: string;
  title_id: string | null;
  raw_title: string | null;
  position: number;
};

async function mapItems(
  supabase: SupabaseClient,
  rows: ItemRow[],
): Promise<ListItem[]> {
  const titleIds = [
    ...new Set(rows.map((r) => r.title_id).filter((x): x is string => Boolean(x))),
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
    // 2D.1: a MATCHED title contributes its canonical name + poster regardless
    // of is_public/deleted_at (Top 12 precedent). Only the link (title_slug)
    // stays live-only (is_public AND deleted_at IS NULL). A title_id-NULL item
    // renders as raw_title text below — never skipped.
    // 2D.3: chunked (≤100 ids/call) — a single list can hold hundreds of items
    // (Dan's watchlist is 203); one .in() over all of them would trip the
    // URL-length cap (the 2B trap).
    const titles = await chunkedIn(titleIds, "lists.mapItems", (chunk) =>
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
  const out: ListItem[] = [];
  for (const r of rows) {
    const t = r.title_id ? titleById.get(r.title_id) : undefined;
    // Link only when live; a matched-but-non-live item renders as text + poster.
    const titleSlug =
      t && t.is_public && t.deleted_at == null ? t.slug : null;
    out.push({
      id: r.id,
      title_id: r.title_id ?? null,
      title_slug: titleSlug,
      title_name: t?.title ?? r.raw_title ?? "Untitled",
      poster_url: t?.poster_url ?? null,
      position: r.position,
    });
  }
  return out;
}

// Is the given title on the signed-in caller's watchlist? (title-page toggle
// initial state — service-role to resolve the creator, anon owner-RLS reads.)
export async function getMyWatchlistStateForTitle(
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
  const { data: wl } = await supabase
    .from("user_lists")
    .select("id")
    .eq("creator_id", creator.id as string)
    .eq("kind", "watchlist")
    .maybeSingle();
  if (!wl?.id) return false;
  // .limit(1) not .maybeSingle(): (list_id, title_id) is not unique, so a dup
  // (from a concurrent add) must not throw here.
  const { data: itemRows } = await supabase
    .from("user_list_items")
    .select("id")
    .eq("list_id", wl.id as string)
    .eq("title_id", titleId)
    .limit(1);
  return Boolean(itemRows && itemRows.length > 0);
}

// Public lists for a creator's profile — anon SSR client, visibility='public'.
// Per-list count + up to 4 matched-title posters; watchlist pinned first when non-empty.
export async function getPublicListsForCreator(
  creatorId: string,
): Promise<PublicListSummary[]> {
  const supabase = await createClient();
  const { data: lists } = await supabase
    .from("user_lists")
    .select("id, name, kind, created_at")
    .eq("creator_id", creatorId)
    .eq("visibility", "public")
    .order("created_at", { ascending: true });
  if (!lists || lists.length === 0) return [];

  const listIds = lists.map((l) => l.id as string);
  const { data: items } = await supabase
    .from("user_list_items")
    .select("list_id, title_id, position")
    .in("list_id", listIds)
    .order("position", { ascending: true });

  // Per list: the FULL count (every item) + the first 4 matched (title_id NOT
  // NULL) items by position. Only those ids — ≤4 per list — feed the poster
  // lookup, NOT every item's id. 2D.1 regressed this by collecting ALL ids: a
  // creator's library is hundreds of items (≈670 distinct for the founder), and
  // one .in() over all of them builds a multi-KB `id=in.(…)` URL that trips the
  // PostgREST/gateway URL-length cap (the 2B.2 trap) — with the error unchecked
  // the entire strip silently blanked. Items arrive already ordered by position.
  const countByList = new Map<string, number>();
  const posterIdsByList = new Map<string, string[]>();
  for (const it of items ?? []) {
    const lid = it.list_id as string;
    const tid = (it.title_id as string | null) ?? null;
    countByList.set(lid, (countByList.get(lid) ?? 0) + 1); // EVERY item
    if (tid) {
      const arr = posterIdsByList.get(lid) ?? [];
      if (arr.length < 4) arr.push(tid);
      posterIdsByList.set(lid, arr);
    }
  }

  // ≤4 × (#public lists) ids → a small, bounded .in() (deduped across lists).
  const posterTitleIds = [...new Set([...posterIdsByList.values()].flat())];
  const posterById = new Map<string, string | null>();
  if (posterTitleIds.length) {
    const { data: titles, error } = await supabase
      .from("titles")
      .select("id, poster_url")
      .in("id", posterTitleIds);
    // A public profile must NEVER fail over posters: check the error, log it,
    // and degrade to empty strips. (Contrast the import worker's loud-fail — a
    // partial title lookup there corrupts the import; here a missing poster is
    // purely cosmetic, so degrade beats throw.)
    if (error) console.error("[lists] poster lookup failed:", error.message);
    for (const t of titles ?? []) {
      posterById.set(t.id as string, (t.poster_url as string | null) ?? null);
    }
  }

  const summaries: PublicListSummary[] = lists.map((l) => {
    const lid = l.id as string;
    // First-4-matched posters in position order; null posters (the rare
    // posterless matched title) drop out, so the strip shows ≤4.
    const posters = (posterIdsByList.get(lid) ?? [])
      .map((tid) => posterById.get(tid) ?? null)
      .filter((p): p is string => Boolean(p));
    return {
      id: lid,
      name: l.name as string,
      kind: l.kind as string,
      item_count: countByList.get(lid) ?? 0,
      posters,
    };
  });

  // Watchlist hidden when empty; otherwise pinned first.
  return summaries
    .filter((s) => s.kind !== "watchlist" || s.item_count > 0)
    .sort((a, b) =>
      a.kind === b.kind ? 0 : a.kind === "watchlist" ? -1 : 1,
    );
}

// One public list with its visible items — /c/[handle]/list/[id]. Returns null
// (→ 404) when the list isn't this creator's or isn't public.
export async function getPublicListDetail(
  creatorId: string,
  listId: string,
): Promise<PublicListDetail | null> {
  const supabase = await createClient();
  const { data: list } = await supabase
    .from("user_lists")
    .select("id, name, description, kind")
    .eq("id", listId)
    .eq("creator_id", creatorId)
    .eq("visibility", "public")
    .maybeSingle();
  if (!list) return null;

  const { data: items } = await supabase
    .from("user_list_items")
    .select("id, title_id, raw_title, position")
    .eq("list_id", listId)
    .order("position", { ascending: true });
  const mapped = await mapItems(supabase, (items ?? []) as ItemRow[]);

  return {
    id: list.id as string,
    name: list.name as string,
    description: (list.description as string | null) ?? null,
    kind: list.kind as string,
    item_count: mapped.length,
    items: mapped,
  };
}

// Owner views (/me) — service-role, all visibilities + all titles.
export async function getMyListsForCreator(
  creatorId: string,
): Promise<MyListSummary[]> {
  const sb = createServiceRoleClient();
  const { data: lists } = await sb
    .from("user_lists")
    .select("id, name, kind, created_at")
    .eq("creator_id", creatorId)
    .order("kind", { ascending: false })
    .order("created_at", { ascending: true });
  if (!lists) return [];
  const { data: items } = await sb
    .from("user_list_items")
    .select("list_id")
    .eq("creator_id", creatorId);
  const count = new Map<string, number>();
  for (const it of items ?? []) {
    const lid = it.list_id as string;
    count.set(lid, (count.get(lid) ?? 0) + 1);
  }
  return lists.map((l) => ({
    id: l.id as string,
    name: l.name as string,
    kind: l.kind as string,
    item_count: count.get(l.id as string) ?? 0,
  }));
}

export async function getMyListDetail(
  creatorId: string,
  listId: string,
): Promise<MyListDetail | null> {
  const sb = createServiceRoleClient();
  const { data: list } = await sb
    .from("user_lists")
    .select("id, name, kind, description, creator_id")
    .eq("id", listId)
    .maybeSingle();
  if (!list || (list.creator_id as string) !== creatorId) return null;
  const { data: items } = await sb
    .from("user_list_items")
    .select("id, title_id, raw_title, position")
    .eq("list_id", listId)
    .order("position", { ascending: true });
  const mapped = await mapItems(sb, (items ?? []) as ItemRow[]);
  return {
    id: list.id as string,
    name: list.name as string,
    kind: list.kind as string,
    description: (list.description as string | null) ?? null,
    items: mapped,
  };
}
