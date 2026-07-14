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
import {
  getActiveEntitlement,
  stampFirstPlay,
} from "@/lib/entitlements/lookup";

// Token signing uses Node crypto.
export const runtime = "nodejs";

// TOKEN TTL (C1, 2026-07-13: was 12h). 4h.
//
// ⚠️ READ THIS BEFORE REASONING ABOUT WHAT THE TTL ENFORCES. An earlier version
// of this comment claimed the TTL bounds "how long a lapsed rental keeps
// playing." THAT WAS FALSE, and it was false because nobody had probed the edge.
// Probed 2026-07-14 against a real published DRM asset:
//
//   playback token (aud "v") gates the MANIFEST, and ONLY the manifest.
//     expired token -> master .m3u8 403, variant .m3u8 403.
//     BUT segment URLs carry NO token at all, and serve HTTP 200 on an expired
//     token — including segments never fetched before (so it is not caching).
//   => Once a player holds the variant playlist it needs the token NEVER AGAIN.
//      An in-flight session runs to the end of the film. A rental that lapses
//      mid-watch DOES NOT STOP. TTL does not, and cannot, change that.
//
// So what is the TTL actually for? The DRM-LICENSE token (aud "d") is the real
// credential: those freely-fetchable segments are CIPHERTEXT, and decrypting
// them needs a content key from Mux's license endpoint. That endpoint DOES
// authenticate the token (probed: valid drm token -> 400 "Invalid Parameters",
// i.e. past auth and rejected on the challenge; EXPIRED drm token -> 403 "Not
// Authorized"). An expired drm token therefore cannot acquire a key.
//
// THE TTL'S ONE REAL JOB: it cuts — 3x, from 12h to 4h — the window in which a
// LEAKED token can acquire a decryption key and start a session. Exposure from a
// leak is ONE SESSION (a new session 403s on both the manifest and the license),
// not unbounded. That is a genuine, if narrow, rights gain. It is NOT session
// termination.
//
// 4h: the longest currently-playable title runs 91 minutes (prod, 2026-07-13),
// so 4h is >2.5x the longest watch plus pause slack — a session that starts on a
// fresh token never has to re-acquire anything mid-film.
//
// Playback and DRM tokens MUST stay TTL-synced — minted together below; a split
// would leave one leg usable after the other died.
//
// STOPPING a lapsed rental mid-watch is a LICENSE-DURATION problem, not a TTL
// problem: the levers are the `licenseExpiration` / `playDuration` claims on the
// drm token (our two-clock rule expressed in the license instead of Postgres).
// That is C1b — designed, not built. Do not pretend the TTL does it.
const TOKEN_TTL = "4h";

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

  // GEO GATE: read the Vercel edge country header and defer to isTerritoryAllowed,
  // which applies the title's per-title territory rights (default-deny on unset).
  // The decision rule lives ENTIRELY in the helper; this route only reads the
  // header and maps a false result -> 451 (branches unchanged).
  //
  // C1: the helper is now PURE and takes the rights off the title we ALREADY
  // loaded (getEpisodeForPlayback) instead of re-querying the same titles row for
  // two more columns. episode.title is non-null here — the canViewTitle gate above
  // already 403'd a missing/soft-deleted title — so the fail-closed-on-null branch
  // inside the helper is belt-and-braces, not the live path.
  const country = request.headers.get("x-vercel-ip-country");
  if (!isTerritoryAllowed(country, episode.title)) {
    return NextResponse.json({ error: "territory_restricted" }, { status: 451 });
  }

  // ENTITLEMENT GATE (transactions sub-unit 3). The gate gates exactly when the
  // title is FOR SALE, derived LIVE from the title's offer flags — NOT from the
  // stored episode.monetization_mode marker (write-only vestigial after this; two
  // writers could set it inconsistently). "Sellable" mirrors the charge route's
  // per-kind condition field-for-field (rent/route.ts:97-108): enabled === true
  // AND an integer price > 0, OR'd across rental and purchase. So "gated" equals
  // "the charge path would sell it" — no gated-but-unbuyable, no buyable-but-
  // ungated. A title with no enabled+priced offer falls straight through to the
  // mint (today's free behavior). episode.title is non-null here (the canViewTitle
  // gate above already 403'd a missing title), so these reads are safe.
  const t = episode.title;
  const rentSellable =
    t.transact_enabled === true &&
    typeof t.transact_price_cents === "number" &&
    Number.isInteger(t.transact_price_cents) &&
    t.transact_price_cents > 0;
  const buySellable =
    t.purchase_enabled === true &&
    typeof t.purchase_price_cents === "number" &&
    Number.isInteger(t.purchase_price_cents) &&
    t.purchase_price_cents > 0;
  const gated = rentSellable || buySellable;
  if (gated) {
    // The entitlement keys on user_id — an anon viewer can't hold one. The
    // frontend routes a 401 to sign-in.
    if (!user) {
      return NextResponse.json({ error: "auth_required" }, { status: 401 });
    }
    // Active = a rental/purchase inside the two-clock window, evaluated on the
    // PRE-stamp row inside getActiveEntitlement. No active entitlement -> 402; the
    // frontend shows Rent.
    const ent = await getActiveEntitlement(user.id, episode.title_id);
    if (!ent) {
      return NextResponse.json({ error: "not_entitled" }, { status: 402 });
    }
    // Active -> arm the 48h clock (DB time, exactly-once, fire-and-proceed), then
    // fall through to the UNCHANGED mint. Stamp AFTER the activeness check above —
    // never before, or the first play would be judged against a value we just wrote.
    //
    // ⚠️ LOAD-BEARING, and MORE so since C1: this call is UNCONDITIONAL — there is
    // no `if (!ent.first_played_at)` guard here. Exactly-once is enforced ONLY by
    // the RPC's own predicate (20260626000001_stamp_first_play.sql:26-29):
    //     update entitlements set first_played_at = now()
    //      where id = p_entitlement_id AND first_played_at IS NULL;
    // C1 added a client REFRESH path, so this route is now re-hit MID-RENTAL, many
    // times per watch. If that `AND first_played_at IS NULL` is ever dropped, every
    // token refresh would re-stamp first_played_at = now() and RESTART the 48-hour
    // clock — an eternal rental, silently, with no error anywhere. Do not "simplify"
    // that predicate.
    await stampFirstPlay(ent.id);
  }

  // Mint both tokens (TOKEN_TTL). Signing is local crypto via the keypair-only
  // signer — no network call to Mux.
  //
  // ⚠️ viewer_user_id is FORENSIC ONLY. It is NOT access control, and no gate
  // anywhere reads it. Mux IGNORES claims it does not recognize: a probe on
  // 2026-07-13 signed a token carrying a pure-gibberish claim and the video edge
  // served the manifest HTTP 200 all the same (control, viewer_user_id, and
  // gibberish all 200 against a real DRM asset). So the claim buys exactly one
  // thing — if a token leaks, its payload names the account that minted it. The
  // ENFORCEMENT levers are (a) TOKEN_TTL and (b) the gate stack above, which
  // re-runs in full on every re-mint the client's refresh path triggers. Never
  // let a future reader mistake this claim for a permission.
  //
  // Claim goes on the PLAYBACK token only. The DRM-license leg stays plain: the
  // probe could not exercise a real license handshake (that needs a CDM), so an
  // unknown-claim rejection there is untested — and it would break playback
  // outright, for zero forensic gain the playback token doesn't already provide.
  const playbackId = episode.mux_playback_id;
  let playbackToken: string;
  let drmToken: string;
  try {
    const signer = getMuxSigner();
    [playbackToken, drmToken] = await Promise.all([
      signer.jwt.signPlaybackId(playbackId, {
        expiration: TOKEN_TTL,
        params: { viewer_user_id: user?.id ?? "anon" },
      }),
      signer.jwt.signDrmLicense(playbackId, { expiration: TOKEN_TTL }),
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
