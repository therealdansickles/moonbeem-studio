import { createClient } from "@/lib/supabase/server";

// Distribution partner order for the homepage logo strip. Hardcoded
// for the 2026-05-12 Emerson Collective pitch. Super-admin reorder
// UI + DB-driven order are deferred to the post-pitch admin work.
// Editing this array changes the order on the homepage strip.
const MARQUEE_PARTNER_ORDER: readonly string[] = [
  "magnolia-pictures",
  "oscilloscope-laboratories",
  "roadside-attractions",
  "topic-studios",
  "1-2-special",
  "mitten-media",
];

export type MarqueePartner = {
  slug: string;
  name: string;
  logo_url: string;
};

export async function getMarqueePartners(): Promise<MarqueePartner[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("partners")
    .select("slug, name, logo_url")
    .in("slug", [...MARQUEE_PARTNER_ORDER]);
  if (error || !data) return [];
  // Index by slug then walk the hardcoded order so the DOM order
  // is deterministic regardless of how the DB returns rows. Skip
  // any partner that's missing a logo_url — the strip is logo-only
  // for pitch (text fallback would feel under-baked next to real
  // marks).
  const bySlug = new Map<string, MarqueePartner>();
  for (const row of data) {
    if (!row.logo_url) continue;
    bySlug.set(row.slug, {
      slug: row.slug as string,
      name: row.name as string,
      logo_url: row.logo_url as string,
    });
  }
  return MARQUEE_PARTNER_ORDER
    .map((slug) => bySlug.get(slug))
    .filter((p): p is MarqueePartner => p !== undefined);
}
