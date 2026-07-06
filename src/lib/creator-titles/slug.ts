// Creator-title slug resolution. The kebab base comes from the shared
// baseTitleSlug (lib/titles/slug.ts); uniqueness is resolved PER CREATOR
// because creator_titles is UNIQUE(creator_id, slug) — a creator title has no
// public /t/[slug] URL in v1 (ruling Q2), so the slug is the creator's own
// catalog namespace, never global. The 23505 unique violation on insert is
// still the final backstop if two creates race between the check and the
// insert (same discipline as the partner resolveUniqueSlug).
//
// No deleted_at filter: the unique constraint covers soft-deleted rows too, so
// a deleted title's slug must still block reuse here or the insert would 23505.

import type { SupabaseClient } from "@supabase/supabase-js";

export async function resolveUniqueCreatorTitleSlug(
  supabase: SupabaseClient,
  creatorId: string,
  base: string,
): Promise<string> {
  for (let i = 1; i <= 50; i++) {
    const candidate = i === 1 ? base : `${base}-${i}`;
    const { data, error } = await supabase
      .from("creator_titles")
      .select("id")
      .eq("creator_id", creatorId)
      .eq("slug", candidate)
      .maybeSingle();
    if (error) throw new Error(`slug check: ${error.message}`);
    if (!data) return candidate;
  }
  throw new Error("slug_unresolvable");
}
