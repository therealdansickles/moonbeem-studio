// GET /api/me/hosting/titles/[id]/episodes/[episodeId]/playback-token
//
// Creator SELF-PREVIEW (Phase 4): the owner mints a short-lived DRM playback
// token for THEIR OWN hosted creator_episode, so they can watch it back on /me
// before there is any public page. Mirrors the sibling mux-jobs GET route's
// authz shape and the partner playback-token route's token-minting, but with the
// viewer gates DELIBERATELY DROPPED.
//
// OWNERSHIP IS THE WHOLE GATE (ruling): authorizeCreatorTitleMutation resolves
// the claimed creator from the session (creators.user_id) inside the helper —
// the caller supplies no identity claim. There is NO canViewTitle / is_public
// read, NO territory gate, NO entitlement/402, and NO stampFirstPlay: an owner
// previewing an unpublished asset is not a viewer, so we never touch first-play
// analytics or any visibility check. Not published, not public — owner-only.
//
// DRM tokens (Phase-3 precedent: DRM is universal for now; the free-tier signed
// split is deferred to Phase 6 — see TIER_MULTI_DRM). The response is per-request
// and secret-bearing, so Cache-Control: no-store. Rate limit is chattyAuthUser
// (generous, per-user): an abuse ceiling, not a throttle — a player retry loop
// must never lock an owner out of their own preview.

import { NextResponse, type NextRequest } from "next/server";
import { getUser } from "@/lib/dal";
import { enforce } from "@/lib/ratelimit";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { authorizeCreatorTitleMutation } from "@/lib/auth/creator-title-mutation";
import { getMuxSigner } from "@/lib/mux";

// JWT signing runs on Node crypto (the keypair signer) — pin the Node runtime.
export const runtime = "nodejs";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; episodeId: string }> },
) {
  const user = await getUser();
  if (!user) {
    return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  }
  const rl = await enforce("chattyAuthUser", user.id, "me/hosting/preview-token");
  if (!rl.ok) return rl.response;

  const { id, episodeId } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "title_not_found" }, { status: 404 });
  }
  if (!UUID_RE.test(episodeId)) {
    return NextResponse.json({ error: "episode_not_found" }, { status: 404 });
  }

  // OWNER GATE — the entire authorization. Ownership is resolved in the helper
  // from the session userId + creator-title id (claimed-creator, un-forgeable).
  const authz = await authorizeCreatorTitleMutation(user.id, id);
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

  // EPISODE -> TITLE REBIND: the episode's creator_title_id (from the row) MUST
  // equal the path title we authorized on — an owner can't read another
  // creator's episode by guessing an id (treat a foreign episode as not-found).
  const { data: ep } = await supabase
    .from("creator_episodes")
    // ⚠️ PHASE-6 DELETE: when per-episode soft-delete lands, this select MUST add
    // the deleted filter (e.g. .is("deleted_at", null)) — otherwise a deleted
    // episode still mints a preview token. Owner-only content today, so not yet a
    // leak, but load-bearing the moment delete ships.
    .select("id, creator_title_id, source, mux_playback_id")
    .eq("id", episodeId)
    .maybeSingle();
  if (!ep || ep.creator_title_id !== id) {
    return NextResponse.json({ error: "episode_not_found" }, { status: 404 });
  }
  // Defensive (creator_episodes_mux_shape guarantees a playback id on a mux row).
  if (ep.source !== "mux" || !ep.mux_playback_id) {
    return NextResponse.json({ error: "not_playable" }, { status: 400 });
  }

  // Mint both tokens (TOKEN_TTL), local crypto via the keypair-only signer —
  // identical to the viewer route's mint, minus everything a viewer needs.
  //
  // TTL 4h (C1, 2026-07-13: was 12h) — the SAME value as the viewer route, on
  // purpose (Dan's ruling). A shorter TTL here would buy nothing: the caller is a
  // creator previewing their OWN unpublished episode, and this mount has NO client
  // refresh path (CreatorEpisodePreview is fetch-on-click, one shot), so a tighter
  // expiry would only add a second, unrecoverable failure surface. No viewer claim
  // either: ownership already identifies the only person who can mint here.
  const playbackId = ep.mux_playback_id as string;
  let playbackToken: string;
  let drmToken: string;
  try {
    const signer = getMuxSigner();
    [playbackToken, drmToken] = await Promise.all([
      signer.jwt.signPlaybackId(playbackId, { expiration: "4h" }),
      signer.jwt.signDrmLicense(playbackId, { expiration: "4h" }),
    ]);
  } catch (err) {
    // Message only — no key material in SDK errors, never the tokens.
    console.error(
      `[creator-preview] token mint failed episode=${episodeId}: ${err instanceof Error ? err.message : "unknown"}`,
    );
    return NextResponse.json({ error: "token_mint_failed" }, { status: 500 });
  }

  // Tokens only — never the key, never logged. no-store: per-request + secret-bearing.
  return NextResponse.json(
    { playbackId, playbackToken, drmToken },
    { headers: { "Cache-Control": "no-store" } },
  );
}
