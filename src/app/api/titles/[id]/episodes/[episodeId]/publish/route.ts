// POST /api/titles/[id]/episodes/[episodeId]/publish
//
// Flip a Mux episode live on the title's Watch tab (title_episodes.is_published
// false -> true). The per-EPISODE content step (distinct from making the TITLE
// publicly listed — that is POST /api/titles/[id]/publish).
//
// SECURITY (clips-PATCH ownership model):
//   1. authorize on the PATH title id (authorizeTitleMutation = super-admin OR
//      owning-partner-admin, ownership resolved server-side, no body claim);
//   2. REBIND (load-bearing): re-SELECT the episode and assert
//      episode.title_id === the path title id — title_id from the ROW, never the
//      body — so an admin of title A cannot publish title B's episode by passing
//      titleId=A + episodeId=B;
//   3. READINESS: only a source='mux' episode with a non-null mux_playback_id may
//      be published. Such a row can ONLY exist because mux_finalize_asset_ready
//      inserts it atomically with the job's status='ready' AFTER a DRM playback
//      id was confirmed — so the row's EXISTENCE is the readiness proof.
//      is_published (the gate being flipped) is never the readiness signal.

import { NextResponse, type NextRequest } from "next/server";
import { revalidatePath } from "next/cache";
import { getUser } from "@/lib/dal";
import { enforce } from "@/lib/ratelimit";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { authorizeTitleMutation } from "@/lib/auth/title-mutation";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; episodeId: string }> },
) {
  const user = await getUser();
  if (!user) {
    return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  }
  const rl = await enforce("partnerWrites", user.id, "titles/episodes/publish");
  if (!rl.ok) return rl.response;

  const { id, episodeId } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "title_not_found" }, { status: 404 });
  }
  if (!UUID_RE.test(episodeId)) {
    return NextResponse.json({ error: "episode_not_found" }, { status: 404 });
  }

  // AUTHORIZE on the path title (super_admin OR owning-partner-admin).
  const authz = await authorizeTitleMutation(user.id, id);
  if (!authz.ok) {
    const status =
      authz.reason === "not_authenticated"
        ? 401
        : authz.reason === "title_not_found"
          ? 404
          : 403;
    return NextResponse.json({ error: authz.reason }, { status });
  }

  const supabase = createServiceRoleClient();

  // OWNERSHIP REBIND: the episode's title_id comes from the row and MUST equal
  // the path title we authorized on. (Treat a foreign episode as not-found.)
  const { data: episode } = await supabase
    .from("title_episodes")
    .select("id, title_id, source, mux_playback_id")
    .eq("id", episodeId)
    .maybeSingle();
  if (!episode || episode.title_id !== id) {
    return NextResponse.json({ error: "episode_not_found" }, { status: 404 });
  }

  // READINESS: only a ready mux episode (existence = readiness per the RPC).
  if (episode.source !== "mux" || !episode.mux_playback_id) {
    return NextResponse.json({ error: "not_ready" }, { status: 409 });
  }

  // TERRITORY (relocated here from the title-publish route): a DRM FILM may only
  // go live once its playback territory rights are declared — worldwide, or a
  // non-empty allow-list. This route is the EXCLUSIVE chokepoint for a Mux film
  // going live (every non-Mux episode is rejected above), so the check fires only
  // on films, never on clip-only / IG titles. Without it a film would publish
  // reachable-but-unplayable. (isTerritoryAllowed default-denies an unset title on
  // the playback-token path — that remains the runtime backstop regardless.)
  const { data: terr } = await supabase
    .from("titles")
    .select("territory_worldwide, allowed_territories")
    .eq("id", id)
    .maybeSingle();
  const hasTerritories =
    terr?.territory_worldwide === true ||
    ((terr?.allowed_territories as string[] | null)?.length ?? 0) > 0;
  if (!hasTerritories) {
    return NextResponse.json({ error: "no_territories_set" }, { status: 409 });
  }

  // WRITE: idempotent flip, scoped by id + title_id (belt-and-suspenders).
  // Select-confirm the result (read-after-write) rather than trusting a count.
  const { data: updated, error: updErr } = await supabase
    .from("title_episodes")
    .update({ is_published: true })
    .eq("id", episodeId)
    .eq("title_id", id)
    .select("id, is_published")
    .maybeSingle();
  if (updErr || !updated) {
    return NextResponse.json(
      { error: updErr?.message ?? "publish_failed" },
      { status: 500 },
    );
  }

  // Surface the now-published episode on the public Watch tab.
  const { data: title } = await supabase
    .from("titles")
    .select("slug")
    .eq("id", id)
    .maybeSingle();
  if (title?.slug) revalidatePath(`/t/${title.slug as string}`);

  return NextResponse.json({
    episodeId: updated.id,
    is_published: updated.is_published,
  });
}
