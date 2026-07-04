// POST /api/titles/[id]/episodes/[episodeId]/subtitles  — attach one subtitle track
// GET  /api/titles/[id]/episodes/[episodeId]/subtitles  — list this episode's tracks
//
// POST: the browser has already PUT the VTT/SRT to R2 (via the presign route). This
// resolves the public R2 URL + the episode's Mux asset id, inserts a subtitle_tracks
// row, calls Mux createTrack, then POLLS the asset track to a terminal state (the
// spike measured ~4.2s to 'ready'; cap generously). STATUS VIA POLLING — a
// video.asset.track.ready webhook at /api/webhooks/mux would be a small future
// upgrade IF the Mux dashboard ever shows track events hitting our endpoint (open
// question at build time). Mux errors are surfaced never-silent (row.error + 502).
//
// GET: re-syncs any still-pending/preparing track from Mux on read, so a slow track
// catches up without a webhook.

import { NextResponse, type NextRequest } from "next/server";
import { getUser } from "@/lib/dal";
import { enforce } from "@/lib/ratelimit";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { authorizeTitleMutation } from "@/lib/auth/title-mutation";
import { getMux } from "@/lib/mux";
import { buildPublicUrl } from "@/lib/r2/upload";

export const maxDuration = 60;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LANG_RE = /^[a-z]{2}(?:-[a-z0-9]{2,8})?$/i;
const POLL_MS = 2000;
const POLL_CAP_MS = 24000; // ~6x the observed 4.2s; still well under maxDuration

const TRACK_COLS = "id, language_code, label, mux_track_id, closed_captions, status, error, created_at";

function authzStatus(reason: string): number {
  return reason === "not_authenticated" ? 401 : reason === "title_not_found" ? 404 : 403;
}

// Load the episode iff it belongs to this title and is a Mux asset.
async function loadMuxEpisode(
  supabase: ReturnType<typeof createServiceRoleClient>,
  titleId: string,
  episodeId: string,
) {
  const { data } = await supabase
    .from("title_episodes")
    .select("id, mux_asset_id, source")
    .eq("id", episodeId)
    .eq("title_id", titleId)
    .maybeSingle();
  if (!data || data.source !== "mux" || !data.mux_asset_id) return null;
  return data as { id: string; mux_asset_id: string; source: string };
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; episodeId: string }> },
) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  const rl = await enforce("partnerWrites", user.id, "titles/subtitles/attach");
  if (!rl.ok) return rl.response;
  const { id, episodeId } = await params;
  if (!UUID_RE.test(id) || !UUID_RE.test(episodeId)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const authz = await authorizeTitleMutation(user.id, id);
  if (!authz.ok) return NextResponse.json({ error: authz.reason }, { status: authzStatus(authz.reason) });

  let body: { key?: unknown; language_code?: unknown; label?: unknown; closed_captions?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    // fall through to validation
  }
  const key = typeof body.key === "string" ? body.key : "";
  const languageCode = typeof body.language_code === "string" ? body.language_code.trim() : "";
  const label = typeof body.label === "string" && body.label.trim() ? body.label.trim() : null;
  const closedCaptions = body.closed_captions === true;
  if (!key || !key.startsWith("subtitles/")) {
    return NextResponse.json({ error: "invalid_key" }, { status: 400 });
  }
  if (!LANG_RE.test(languageCode)) {
    return NextResponse.json({ error: "invalid_lang" }, { status: 400 });
  }

  const supabase = createServiceRoleClient();
  const episode = await loadMuxEpisode(supabase, id, episodeId);
  if (!episode) return NextResponse.json({ error: "episode_not_mux" }, { status: 400 });

  // 1. Insert the row FIRST (pending) so a failure is never silent.
  const { data: row, error: insErr } = await supabase
    .from("subtitle_tracks")
    .insert({
      title_episode_id: episodeId,
      language_code: languageCode,
      label,
      closed_captions: closedCaptions,
      status: "pending",
    })
    .select(TRACK_COLS)
    .single();
  if (insErr || !row) {
    return NextResponse.json({ error: "insert_failed", detail: insErr?.message }, { status: 500 });
  }

  // 2. Create the Mux track from the public R2 URL.
  const publicUrl = buildPublicUrl(key);
  const mux = getMux();
  let track: { id: string; status?: string };
  try {
    track = (await mux.video.assets.createTrack(episode.mux_asset_id, {
      language_code: languageCode,
      type: "text",
      text_type: "subtitles",
      url: publicUrl,
      ...(label ? { name: label } : {}),
      closed_captions: closedCaptions,
    } as never)) as { id: string; status?: string };
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    await supabase
      .from("subtitle_tracks")
      .update({ status: "errored", error: detail, updated_at: new Date().toISOString() })
      .eq("id", row.id);
    return NextResponse.json({ error: "mux_create_track_failed", detail }, { status: 502 });
  }

  // 3. Stamp the track id + poll to a terminal state (spike: ~4.2s).
  let status = track.status ?? "preparing";
  await supabase
    .from("subtitle_tracks")
    .update({ mux_track_id: track.id, status, updated_at: new Date().toISOString() })
    .eq("id", row.id);

  const started = Date.now();
  while (status !== "ready" && status !== "errored" && Date.now() - started < POLL_CAP_MS) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    try {
      const asset = (await mux.video.assets.retrieve(episode.mux_asset_id)) as {
        tracks?: { id: string; status?: string }[];
      };
      const t = (asset.tracks ?? []).find((x) => x.id === track.id);
      if (t?.status) status = t.status;
    } catch {
      break; // poll is best-effort; the row keeps its last known status
    }
  }
  const { data: finalRow } = await supabase
    .from("subtitle_tracks")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", row.id)
    .select(TRACK_COLS)
    .single();

  return NextResponse.json({ track: finalRow ?? { ...row, mux_track_id: track.id, status } });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; episodeId: string }> },
) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  const rl = await enforce("partnerWrites", user.id, "titles/subtitles/list");
  if (!rl.ok) return rl.response;
  const { id, episodeId } = await params;
  if (!UUID_RE.test(id) || !UUID_RE.test(episodeId)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const authz = await authorizeTitleMutation(user.id, id);
  if (!authz.ok) return NextResponse.json({ error: authz.reason }, { status: authzStatus(authz.reason) });

  const supabase = createServiceRoleClient();
  const episode = await loadMuxEpisode(supabase, id, episodeId);
  if (!episode) return NextResponse.json({ error: "episode_not_mux" }, { status: 400 });

  const { data: rows } = await supabase
    .from("subtitle_tracks")
    .select(TRACK_COLS)
    .eq("title_episode_id", episodeId)
    .order("created_at", { ascending: true });
  const tracks = (rows ?? []) as { id: string; mux_track_id: string | null; status: string }[];

  // Re-sync any non-terminal track from Mux (catches up a slow track without a webhook).
  const pending = tracks.filter((t) => (t.status === "pending" || t.status === "preparing") && t.mux_track_id);
  if (pending.length > 0) {
    try {
      const asset = (await getMux().video.assets.retrieve(episode.mux_asset_id)) as {
        tracks?: { id: string; status?: string }[];
      };
      const byId = new Map((asset.tracks ?? []).map((t) => [t.id, t.status]));
      for (const t of pending) {
        const live = t.mux_track_id ? byId.get(t.mux_track_id) : undefined;
        if (live && live !== t.status) {
          await supabase
            .from("subtitle_tracks")
            .update({ status: live, updated_at: new Date().toISOString() })
            .eq("id", t.id);
          t.status = live;
        }
      }
    } catch {
      // best-effort re-sync; return the stored rows regardless
    }
  }

  return NextResponse.json({ tracks });
}
