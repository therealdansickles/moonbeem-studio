// DELETE /api/titles/[id]/episodes/[episodeId]/subtitles/[trackId]
//
// Removes a subtitle track from the Mux asset (deleteTrack) and drops our row. trackId
// is the subtitle_tracks.id. Idempotent on a Mux 404 (track already gone) — we still
// clean our row. authorizeTitleMutation gate, same as attach.

import { NextResponse, type NextRequest } from "next/server";
import { getUser } from "@/lib/dal";
import { enforce } from "@/lib/ratelimit";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { authorizeTitleMutation } from "@/lib/auth/title-mutation";
import { getMux } from "@/lib/mux";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; episodeId: string; trackId: string }> },
) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  const rl = await enforce("partnerWrites", user.id, "titles/subtitles/delete");
  if (!rl.ok) return rl.response;

  const { id, episodeId, trackId } = await params;
  if (!UUID_RE.test(id) || !UUID_RE.test(episodeId) || !UUID_RE.test(trackId)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const authz = await authorizeTitleMutation(user.id, id);
  if (!authz.ok) {
    const status =
      authz.reason === "not_authenticated" ? 401 : authz.reason === "title_not_found" ? 404 : 403;
    return NextResponse.json({ error: authz.reason }, { status });
  }

  const supabase = createServiceRoleClient();
  const { data: ep } = await supabase
    .from("title_episodes")
    .select("id, mux_asset_id, source")
    .eq("id", episodeId)
    .eq("title_id", id)
    .maybeSingle();
  if (!ep || ep.source !== "mux" || !ep.mux_asset_id) {
    return NextResponse.json({ error: "episode_not_mux" }, { status: 400 });
  }
  const { data: row } = await supabase
    .from("subtitle_tracks")
    .select("id, mux_track_id")
    .eq("id", trackId)
    .eq("title_episode_id", episodeId)
    .maybeSingle();
  if (!row) return NextResponse.json({ error: "track_not_found" }, { status: 404 });

  if (row.mux_track_id) {
    try {
      await getMux().video.assets.deleteTrack(ep.mux_asset_id as string, row.mux_track_id as string);
    } catch (e) {
      const status = (e as { status?: number })?.status;
      if (status !== 404) {
        const detail = e instanceof Error ? e.message : String(e);
        return NextResponse.json({ error: "mux_delete_track_failed", detail }, { status: 502 });
      }
      // 404 = Mux track already gone; fall through to clean our row.
    }
  }

  const { error: delErr } = await supabase.from("subtitle_tracks").delete().eq("id", trackId);
  if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
