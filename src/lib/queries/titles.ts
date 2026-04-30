import { createClient } from "@/lib/supabase/server";

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
  is_featured: boolean;
};

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

export async function getFeaturedTitles(): Promise<Title[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("titles")
    .select("*")
    .eq("is_featured", true)
    .eq("is_active", true)
    .order("created_at", { ascending: true });
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
    .order("display_order", { ascending: true });
  if (error || !data) return [];
  return data as Still[];
}

export type FanEdit = {
  id: string;
  title_id: string;
  platform: "tiktok" | "instagram" | "youtube" | "x";
  embed_url: string;
  caption: string | null;
  creator_handle_displayed: string | null;
  display_order: number;
  is_active: boolean;
};

export async function getActiveFanEditsForTitle(
  titleId: string,
): Promise<FanEdit[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("fan_edits")
    .select("*")
    .eq("title_id", titleId)
    .order("display_order", { ascending: true });
  if (error || !data) return [];
  return data as FanEdit[];
}

export type FanEditWithTitle = {
  id: string;
  title_id: string;
  creator_handle: string;
  platform: "tiktok" | "instagram" | "youtube" | "x";
  embed_url: string;
  title_slug: string;
  title_name: string;
  title_poster_url: string;
  created_at: string;
};

type FanEditJoinRow = {
  id: string;
  title_id: string;
  platform: "tiktok" | "instagram" | "youtube" | "x";
  embed_url: string;
  creator_handle_displayed: string | null;
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
      "id, title_id, platform, embed_url, creator_handle_displayed, created_at, titles!inner(slug, title, poster_url, is_active)",
    )
    .eq("is_active", true)
    .eq("verification_status", "auto_verified")
    .eq("titles.is_active", true)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error || !data) return [];
  return (data as unknown as FanEditJoinRow[])
    .filter((r) => r.titles && r.titles.poster_url)
    .map((r) => ({
      id: r.id,
      title_id: r.title_id,
      creator_handle: r.creator_handle_displayed ?? "anon",
      platform: r.platform,
      embed_url: r.embed_url,
      title_slug: r.titles!.slug,
      title_name: r.titles!.title,
      title_poster_url: r.titles!.poster_url!,
      created_at: r.created_at,
    }));
}
