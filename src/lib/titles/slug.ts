// Title slug generation — shared by the super-admin create route
// (POST /api/admin/titles) and the partner create route
// (POST /api/p/[slug]/titles). ONE source of truth so both paths produce
// kebab slugs that are unique across the WHOLE titles table (slugs are the
// public /t/[slug] key, globally unique — never per-partner).

import type { SupabaseClient } from "@supabase/supabase-js";

// "Last Tango in Park City" + 2026 → "last-tango-in-park-city-2026".
// Same kebab discipline as the partner slug suggester.
export function baseTitleSlug(title: string, year: number | null): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return year ? `${base}-${year}` : base;
}

// Find a free slug by appending -2, -3, … against the whole titles table
// (idx_titles_slug makes the exact-match lookup cheap). The 23505 unique
// violation on insert is still the final backstop if two creates race
// between the check and the insert.
export async function resolveUniqueSlug(
  supabase: SupabaseClient,
  base: string,
): Promise<string> {
  for (let i = 1; i <= 50; i++) {
    const candidate = i === 1 ? base : `${base}-${i}`;
    const { data, error } = await supabase
      .from("titles")
      .select("id")
      .eq("slug", candidate)
      .maybeSingle();
    if (error) throw new Error(`slug check: ${error.message}`);
    if (!data) return candidate;
  }
  throw new Error("slug_unresolvable");
}
