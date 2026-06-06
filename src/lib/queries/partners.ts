import { createServiceRoleClient } from "@/lib/supabase/service";

// Distribution partner logo strip for the homepage. DB-driven order
// via partners.marquee_order (ASC) since 20260512000008; previously
// hardcoded for the 2026-05-12 Emerson Collective pitch. Super-admin
// curation lives at /admin/marquee.

export type MarqueePartner = {
  slug: string;
  name: string;
  logo_url: string;
};

export async function getMarqueePartners(): Promise<MarqueePartner[]> {
  // Service-role client: partners has RLS enabled with no SELECT
  // policy yet, so the cookie-bound anon client returns zero rows
  // for unauthenticated visitors. Matches the convention used by
  // /p/[slug] page. Followup queued to add a public SELECT policy
  // so future public reads can drop the service-role escalation.
  //
  // logo_url IS NOT NULL filter preserved from the pitch-day query —
  // the strip is logo-only by design (text fallback would feel
  // under-baked next to real marks). A marquee_visible partner without
  // a logo holds their slot and renders once they upload one.
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from("partners")
    .select("slug, name, logo_url")
    .eq("is_marquee_visible", true)
    .not("logo_url", "is", null)
    .order("marquee_order", { ascending: true });
  if (error || !data) return [];
  return data
    .filter((r): r is { slug: string; name: string; logo_url: string } =>
      typeof r.logo_url === "string" && r.logo_url.length > 0,
    )
    .map((r) => ({ slug: r.slug, name: r.name, logo_url: r.logo_url }));
}

export type PartnerSummary = {
  id: string;
  name: string;
  logo_url: string | null;
};

// Scoped partner lookup by id — used by the EVENT title page to render the
// league/partner logo "up top". No reusable partner-by-id getter existed
// before this (only inline .from("partners") reads scattered across admin
// routes). Service-role for the same RLS reason as getMarqueePartners
// (partners has RLS on with no public SELECT policy). Returns name +
// logo_url so the title page can do the logo_url → name-text → nothing
// fallback chain. This is fetched ONLY for events; getTitleBySlug is not
// modified.
export async function getPartnerById(
  id: string,
): Promise<PartnerSummary | null> {
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from("partners")
    .select("id, name, logo_url")
    .eq("id", id)
    .maybeSingle();
  if (error || !data) return null;
  return {
    id: data.id as string,
    name: data.name as string,
    logo_url: (data.logo_url as string | null) ?? null,
  };
}
