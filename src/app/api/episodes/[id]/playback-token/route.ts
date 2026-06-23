// POST /api/episodes/[id]/playback-token — mint a per-viewer Mux playback +
// DRM-license token for a 'mux' episode. Gated by the SAME canViewTitle check
// the public title page uses, so access mirrors page visibility exactly: anon
// passes on public titles, anon fails on hidden titles, any authenticated user
// passes on any title. This is the playback unit's per-viewer gate.
//
// NO player and NO publish here — those are later steps. Returns ONLY the tokens.

import { NextResponse, type NextRequest } from "next/server";
import { getUser } from "@/lib/dal";
import { enforce, getIp } from "@/lib/ratelimit";
import { canViewTitle } from "@/lib/title-access";
import { getEpisodeForPlayback } from "@/lib/playback/episode";
import { isTerritoryAllowed } from "@/lib/playback/territory";
import { getMuxSigner } from "@/lib/mux";

// Token signing uses Node crypto.
export const runtime = "nodejs";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  // Session user resolved only for rate-limit keying — canViewTitle resolves the
  // session itself for the actual gate (cookie-aware), so anon is allowed exactly
  // as the page permits.
  const user = await getUser();

  // Viewer-facing, anon-allowed: bound anon per-IP (mirrors the clips/stills
  // download routes — standardAnon, keyed userId-or-IP).
  const rl = await enforce(
    "standardAnon",
    user?.id ?? getIp(request),
    "episodes/[id]/playback-token",
  );
  if (!rl.ok) return rl.response;

  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "episode_not_found" }, { status: 404 });
  }

  const episode = await getEpisodeForPlayback(id);
  if (!episode) {
    return NextResponse.json({ error: "episode_not_found" }, { status: 404 });
  }

  // Instagram episodes play via the public embed and need no token.
  if (episode.source !== "mux" || !episode.mux_playback_id) {
    return NextResponse.json({ error: "not_a_mux_episode" }, { status: 400 });
  }

  // Owning title must exist (not soft-deleted) and be viewable by this caller —
  // the SAME gate as /t/[slug]. A missing/deleted title is fail-closed (deny).
  if (!episode.title) {
    return NextResponse.json({ error: "not_authorized" }, { status: 403 });
  }
  const visible = await canViewTitle({
    is_public: episode.title.is_public,
    partner_id: episode.title.partner_id,
  });
  if (!visible) {
    return NextResponse.json({ error: "not_authorized" }, { status: 403 });
  }

  // GEO SEAM (present, not enforcing). Read the Vercel edge country header and
  // defer to isTerritoryAllowed, which currently returns true unconditionally.
  // The upload-flow unit will populate per-title territory data + fill in that
  // helper's body ONLY — it must never touch this route. A false result -> 451.
  const country = request.headers.get("x-vercel-ip-country");
  if (!isTerritoryAllowed(country, { id: episode.title_id })) {
    return NextResponse.json({ error: "territory_restricted" }, { status: 451 });
  }

  // Mint both tokens (12h). Signing is local crypto via the keypair-only signer.
  const playbackId = episode.mux_playback_id;
  let playbackToken: string;
  let drmToken: string;
  try {
    const signer = getMuxSigner();
    [playbackToken, drmToken] = await Promise.all([
      signer.jwt.signPlaybackId(playbackId, { expiration: "12h" }),
      signer.jwt.signDrmLicense(playbackId, { expiration: "12h" }),
    ]);
  } catch (err) {
    // Log the message only (no key material in SDK errors), never the tokens.
    console.error(
      `[playback-token] mint failed for episode=${id}: ${err instanceof Error ? err.message : "unknown"}`,
    );
    return NextResponse.json({ error: "token_mint_failed" }, { status: 500 });
  }

  // Tokens only — never the signing key, never logged.
  return NextResponse.json({ playbackId, playbackToken, drmToken });
}
