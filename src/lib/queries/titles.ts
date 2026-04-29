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
};

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
