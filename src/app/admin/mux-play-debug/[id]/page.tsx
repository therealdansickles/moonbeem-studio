// ============================================================================
// TEMP debug page — DELETE BEFORE MERGE (step 4 player verification only).
// ============================================================================
// Super-admin only via requireSuperAdminOr404 (404 hides existence). Renders the
// real EpisodeModal for ONE episode by id, bypassing the is_published filter (a
// direct lookup, not getTitleEpisodes), so we can verify mux DRM playback BEFORE
// publishing (step 5). It does NOT publish anything and is not linked from any
// UI. Folder is `mux-play-debug` (NOT `_debug` — underscore folders are
// non-routable in the App Router).

import { requireSuperAdminOr404 } from "@/lib/dal";
import { createServiceRoleClient } from "@/lib/supabase/service";
import type { TitleEpisode } from "@/lib/queries/titles";
import MuxPlayDebugClient from "./MuxPlayDebugClient";

export const runtime = "nodejs";

export default async function MuxPlayDebugPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireSuperAdminOr404();

  const { id } = await params;
  const supabase = createServiceRoleClient();
  const { data } = await supabase
    .from("title_episodes")
    .select(
      "id, title_id, episode_number, label, embed_url, source, mux_playback_id, requires_drm, access, cover_image_url, is_published",
    )
    .eq("id", id)
    .maybeSingle();

  if (!data) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-moonbeem-black text-moonbeem-ink">
        episode not found: {id}
      </div>
    );
  }

  return <MuxPlayDebugClient episode={data as TitleEpisode} />;
}
