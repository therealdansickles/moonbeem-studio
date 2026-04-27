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
