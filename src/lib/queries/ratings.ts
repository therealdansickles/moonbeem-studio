// Phase 1A — server-side read of the signed-in caller's own rating for a
// title, for the title-header "Your rating" control. Resolves the caller's
// creator via the service-role client (creators has no anon SELECT policy),
// then reads the rating under the anon SSR client — the title_ratings
// owner-all RLS policy covers an owner reading their own row.
//
// Returns hasCreator so the page can distinguish a signed-in creatorless user
// (→ no_creator nudge) from a signed-in user with a creator (→ interactive).

import { getUser } from "@/lib/dal";
import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service";

export async function getMyRatingForTitle(
  titleId: string,
): Promise<{ hasCreator: boolean; creatorId: string | null; rating: number | null }> {
  const user = await getUser(); // cached (react cache) — dedupes with the page
  if (!user) return { hasCreator: false, creatorId: null, rating: null };

  const service = createServiceRoleClient();
  const { data: creator } = await service
    .from("creators")
    .select("id")
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!creator?.id) return { hasCreator: false, creatorId: null, rating: null };

  const supabase = await createClient();
  const { data: row } = await supabase
    .from("title_ratings")
    .select("rating")
    .eq("title_id", titleId)
    .eq("creator_id", creator.id as string)
    .maybeSingle();

  return {
    hasCreator: true,
    creatorId: creator.id as string,
    rating: row ? Number(row.rating) : null,
  };
}
