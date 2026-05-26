// Source of truth for the homepage's orderable carousel sections.
// The 'moonbeem.' wordmark at the top of the page is a fixed header
// and is NOT one of these sections.
//
// Per-row pin / hide curation (slices A/B/C) lives on the entity
// tables (titles.allfilms_pin_order, fan_edits.recent_pin_order /
// trending_pin_order, plus the matching is_hidden_from_* flags).
// This module is strictly about the vertical order of the sections
// themselves.
//
// Reads the homepage_sections table (slug PK + display_order ASC).
// Falls back to DEFAULT_HOMEPAGE_SECTION_ORDER if the DB returns
// empty or fewer rows than expected, so a mid-migration race or a
// hand-deleted row can't blank the homepage.

import { createServiceRoleClient } from "@/lib/supabase/service";

export const HOMEPAGE_SECTION_SLUGS = [
  "marquee",
  "featured",
  "trending",
  "recent",
  "all-films",
] as const;

export type HomepageSectionSlug = (typeof HOMEPAGE_SECTION_SLUGS)[number];

export const HOMEPAGE_SECTION_LABELS: Record<HomepageSectionSlug, string> = {
  marquee: "Partners (marquee)",
  featured: "Featured Films",
  trending: "Trending Edits",
  recent: "Recent Edits",
  "all-films": "All Films",
};

// Default order matches today's hardcoded JSX in src/app/page.tsx.
// Used as the fallback when the DB returns empty / partial state and
// as the seed value in the migration.
export const DEFAULT_HOMEPAGE_SECTION_ORDER: HomepageSectionSlug[] = [
  "marquee",
  "featured",
  "trending",
  "recent",
  "all-films",
];

const KNOWN_SLUGS = new Set<string>(HOMEPAGE_SECTION_SLUGS);

function isHomepageSectionSlug(s: string): s is HomepageSectionSlug {
  return KNOWN_SLUGS.has(s);
}

// Returns the configured section order, top-to-bottom. Defensive on
// the read side:
//   - DB error → log + fall back to DEFAULT.
//   - Empty result → fall back to DEFAULT.
//   - Unknown slug in the result → drop it (CHECK constraint should
//     prevent this, but a constraint extension mid-deploy could
//     transiently allow new slugs the code doesn't render yet).
//   - Missing slug in the result → append in DEFAULT order at the
//     end so the section still renders.
export async function getHomepageSectionOrder(): Promise<HomepageSectionSlug[]> {
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from("homepage_sections")
    .select("slug, display_order")
    .order("display_order", { ascending: true });
  if (error) {
    console.error(
      `[homepage-sections] read failed; falling back to default order: ${error.message}`,
    );
    return [...DEFAULT_HOMEPAGE_SECTION_ORDER];
  }

  const fromDb: HomepageSectionSlug[] = [];
  const seen = new Set<HomepageSectionSlug>();
  for (const r of data ?? []) {
    const slug = String(r.slug);
    if (!isHomepageSectionSlug(slug)) continue;
    if (seen.has(slug)) continue;
    seen.add(slug);
    fromDb.push(slug);
  }

  if (fromDb.length === 0) {
    return [...DEFAULT_HOMEPAGE_SECTION_ORDER];
  }

  // Append any missing-from-DB slugs at the end in DEFAULT order, so
  // a newly-added section that doesn't yet have a row still renders.
  const missing = DEFAULT_HOMEPAGE_SECTION_ORDER.filter(
    (s) => !seen.has(s),
  );
  return [...fromDb, ...missing];
}
