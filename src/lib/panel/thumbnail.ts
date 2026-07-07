// Server-side thumbnail composition for the panel catalog (PANEL_ENDPOINT_SPEC
// §6a/§10). Per title: the first published Mux episode's signed thumbnail if one
// exists, else the title's poster_url. The panel receives ONE opaque, possibly-
// expiring thumbnail_url per title and has no client-side fallback.
//
// §10 normalize is already satisfied UPSTREAM by data: every catalog poster is a
// JPEG on a panel-decodable host (Mux thumbnail.jpg / TMDB /t/p/ / R2), the one
// squarespace WebP-under-.png having been re-hosted to R2 as JPEG. So this
// module never hands the panel WebP and needs no per-request re-encode.

import type { SupabaseClient } from "@supabase/supabase-js";
import { getMuxSigner } from "@/lib/mux";
import { titleThumbFallback } from "./catalog";

const MUX_THUMB_WIDTH = "480"; // §6a
const MUX_THUMB_TTL = "1h"; // §6a — signed image tokens expire; panel refresh-on-open

// image.mux.com thumbnail URL. A DRM (signed-policy) playback id REQUIRES a
// signed image token (type:"thumbnail", width baked into the token's params);
// the URL then carries ONLY ?token=. A public-policy id needs no token (dead
// branch today — all catalog Mux episodes are requires_drm — but kept correct).
async function muxThumbnailUrl(
  signer: ReturnType<typeof getMuxSigner>,
  playbackId: string,
  requiresDrm: boolean,
): Promise<string> {
  if (!requiresDrm) {
    return `https://image.mux.com/${playbackId}/thumbnail.jpg?width=${MUX_THUMB_WIDTH}`;
  }
  const token = await signer.jwt.signPlaybackId(playbackId, {
    type: "thumbnail",
    expiration: MUX_THUMB_TTL,
    params: { width: MUX_THUMB_WIDTH },
  });
  return `https://image.mux.com/${playbackId}/thumbnail.jpg?token=${token}`;
}

// Compose one thumbnail_url per titleId. ONE batched episode read for the page
// (not the per-title listing layer — episodes aren't part of that deferral),
// then the signer is built only if at least one title has a Mux episode.
export async function composeTitleThumbnails(
  supabase: SupabaseClient,
  titleIds: string[],
  posterByTitle: Map<string, string | null>,
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (titleIds.length === 0) return out;

  const { data: eps } = await supabase
    .from("title_episodes")
    .select("title_id, mux_playback_id, requires_drm, episode_number")
    .in("title_id", titleIds)
    .eq("is_published", true)
    .not("mux_playback_id", "is", null)
    .order("episode_number", { ascending: true });

  // First published Mux episode per title (episode_number asc → first seen wins).
  const firstEp = new Map<string, { playbackId: string; requiresDrm: boolean }>();
  for (const e of eps ?? []) {
    const tid = e.title_id as string;
    if (!firstEp.has(tid)) {
      firstEp.set(tid, {
        playbackId: e.mux_playback_id as string,
        requiresDrm: !!e.requires_drm,
      });
    }
  }

  const signer = firstEp.size > 0 ? getMuxSigner() : null;
  for (const tid of titleIds) {
    const ep = firstEp.get(tid);
    const muxUrl =
      ep && signer
        ? await muxThumbnailUrl(signer, ep.playbackId, ep.requiresDrm)
        : null;
    out.set(tid, titleThumbFallback(muxUrl, posterByTitle.get(tid) ?? null));
  }
  return out;
}
