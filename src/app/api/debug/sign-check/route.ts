// ============================================================================
// TEMPORARY DEBUG ROUTE — DELETE BEFORE MERGE.
// ============================================================================
// Validates the Mux playback signing keypair FORMAT server-side on the preview,
// where MUX_SIGNING_KEY_ID / MUX_SIGNING_PRIVATE_KEY live in Vercel (the key
// never touches a laptop or a local file). Double-gated; anyone else gets a bare
// 404 so the route's existence is hidden:
//   (1) a query token matching DEBUG_SIGN_CHECK_TOKEN, and
//   (2) a super-admin session (same getUser + role='super_admin' check the
//       admin gate uses; inline explicit-404 because notFound() in a route
//       handler is not a proven pattern in this codebase).
// On success it returns ONLY each token's decoded header+payload claims
// (alg/kid/aud/exp/sub) and an ok flag — NEVER the signature, the full token, or
// any key material. On a signing throw it returns the error MESSAGE (which
// surfaces PEM/base64 format problems) but never key material.
//
// NOTE: folder is `debug` (NOT `_debug`) — underscore-prefixed folders are
// private/non-routable in the App Router.

import { NextResponse, type NextRequest } from "next/server";
import { getUser } from "@/lib/dal";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { getMuxSigner } from "@/lib/mux";

// JWT signing uses Node crypto.
export const runtime = "nodejs";

const PLAYBACK_ID = "in9Adqwne84i502GP80001LMw00oueDeazhkFHCxZidiii4";

const fourOhFour = () => new NextResponse(null, { status: 404 });

// Decode header + payload ONLY — never touch the signature ([2]).
function claims(jwt: string) {
  const [h, p] = jwt.split(".");
  const dec = (s: string) =>
    JSON.parse(Buffer.from(s, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
  const header = dec(h);
  const payload = dec(p);
  return {
    alg: header.alg ?? null,
    kid: header.kid ?? null,
    aud: payload.aud ?? null,
    exp: payload.exp ?? null,
    sub: payload.sub ?? null,
  };
}

async function signOne(
  kind: "playback" | "drm",
): Promise<{ ok: true; claims: ReturnType<typeof claims> } | { ok: false; error: string }> {
  try {
    const signer = getMuxSigner();
    const token =
      kind === "playback"
        ? await signer.jwt.signPlaybackId(PLAYBACK_ID, { expiration: "1h" })
        : await signer.jwt.signDrmLicense(PLAYBACK_ID, { expiration: "1h" });
    return { ok: true, claims: claims(token) };
  } catch (err) {
    // Message only — reveals format problems (PEM parse / base64), never the key.
    return { ok: false, error: err instanceof Error ? err.message : "sign_failed" };
  }
}

export async function GET(request: NextRequest) {
  // Gate 1: query token. Missing env or mismatch -> 404 (no DB, no session hint).
  const expected = process.env.DEBUG_SIGN_CHECK_TOKEN;
  const provided = request.nextUrl.searchParams.get("token");
  if (!expected || provided !== expected) return fourOhFour();

  // Gate 2: super-admin session.
  const user = await getUser();
  if (!user) return fourOhFour();
  const svc = createServiceRoleClient();
  const { data: urow } = await svc
    .from("users")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();
  if ((urow?.role as string | undefined) !== "super_admin") return fourOhFour();

  // Validated caller: sign both tokens, return claims only.
  const [playback, drm] = await Promise.all([signOne("playback"), signOne("drm")]);
  return NextResponse.json({ playback_id: PLAYBACK_ID, playback, drm });
}
