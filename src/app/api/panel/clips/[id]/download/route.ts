// GET /api/panel/clips/[id]/download — Bearer-gated, verified-creator-only clip
// download for the Premiere panel (Stage 3). The panel's FIRST action: a verified
// Moonbeem creator, authenticated by their API token, pulls a permissioned clip to
// import into Premiere. We log who pulled which clip for IP-owner traceability.
//
// This is a NEW, Bearer-only route. The existing cookie-authed web download
// (/api/clips/[id]/download) and the public /t/[slug] render are UNTOUCHED. We do
// not add dual-auth to one route — the panel policy (verified REQUIRED + token
// auth + panel logging) is cleanly separated from the web soft-gate.
//
// Serving: gate + log run server-side, then we 302-redirect to the clip's already
// public R2 file_url. R2 honors Range/resume and has no function timeout/size
// ceiling — a byte-proxy would truncate the large clips the panel pulls (a 1.34GB
// .mov exists). file_url is already public (the web <video> ships it), so the
// redirect exposes nothing the public render doesn't.
//
// MONEY BOUNDARY: content-only. This route imports ONLY token auth
// (verifyApiToken/requireScope), the verification tier check (getUserTier), the
// traceability logger (logUserEvent), the rate-limiter (enforce/getIp), the
// service-role client, and the pure action-hint parser (resolveActionHint —
// string comparisons only, zero imports). It imports NO earnings/metering/
// withdraw/campaign-billing/stripe code. The token scope is content-only; no
// money action is reachable here.

import { NextResponse, type NextRequest } from "next/server";
import { verifyApiToken, requireScope } from "@/lib/api-tokens/verify";
import { getUserTier } from "@/lib/gating/get-user-tier";
import { logUserEvent } from "@/lib/events/log-event";
import { resolveActionHint } from "@/lib/panel/action";
import { enforce, getIp } from "@/lib/ratelimit";
import { createServiceRoleClient } from "@/lib/supabase/service";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  // (1) IP-KEYED RATE LIMIT — BEFORE the token lookup (security must-do #1). This
  // is an unauthenticated entry point: a garbage Bearer must hit an IP cap before
  // the SHA-256 + token-table lookup, so the endpoint can't hammer api_tokens.
  // Tighter tier (10/min) than the web download (standardAnon 60/min). Mirrors the
  // web route's `enforce(<tier>, getIp(request), "<route>")` shape.
  const rl = await enforce("tightAnon", getIp(request), "panel/clips/download");
  if (!rl.ok) return rl.response;

  // (2) Authenticate by Bearer API token. verifyApiToken returns
  // { userId, creatorId, scopes, tokenId } or null for ANY failure (absent /
  // malformed / unknown / revoked / expired / rate-limited / no creator).
  const auth = await verifyApiToken(request);
  if (!auth) {
    return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  }

  // (3) Authorize the specific action. requireScope returns a 403 NextResponse
  // when the token lacks the scope, else null.
  const denied = requireScope(auth, "clip:download");
  if (denied) return denied;

  // (4) VERIFIED-CREATOR GATE. "Verified" = getUserTier === "verified" = the
  // creator has >= 1 verified creator_socials row (verified_at IS NOT NULL). A
  // token can only be minted by a creator, but verification is separate — an
  // unverified creator holding a token is rejected here.
  const tier = await getUserTier(auth.userId);
  if (tier !== "verified") {
    return NextResponse.json({ error: "not_verified" }, { status: 403 });
  }

  // (5) Load the clip (service-role; clips reads go through service-role).
  const supabase = createServiceRoleClient();
  const { data: clip } = await supabase
    .from("clips")
    .select("file_url, title_id, deleted_at")
    .eq("id", id)
    .maybeSingle();
  if (!clip || clip.deleted_at || !clip.file_url) {
    return NextResponse.json({ error: "clip_not_found" }, { status: 404 });
  }

  // Optional campaign context. The panel knows its campaign; clip->campaign is
  // NOT reliably derivable server-side (a title can be in multiple campaigns), so
  // we accept it as an optional query param and record it only if present + valid.
  const campaignParam = request.nextUrl.searchParams.get("campaign_id");
  const campaignId =
    campaignParam && UUID_RE.test(campaignParam) ? campaignParam : null;

  // Optional action hint (E.1): the panel sends ?action=import on the Import
  // lane, ?action=download on the Download-to-disk lane. Absent/junk resolves
  // to "unspecified" — old panel builds keep working unattributed-but-honest.
  // Duplicated params: .get() takes the first value (malformed client).
  // Unrelated to the auth-flow ?action= deep-link param (/auth/callback, /login).
  const action = resolveActionHint(request.nextUrl.searchParams.get("action"));

  // (6) LOG for IP-owner traceability — reuse logUserEvent (no schema change). The
  // source:"panel" metadata is the discriminator; event_type stays "download_clip"
  // (NOT a panel-specific type — that would split quota/gating filters). The
  // action key discriminates the panel's Import vs Download lanes. Fail-soft:
  // logUserEvent never throws.
  await logUserEvent({
    user_id: auth.userId,
    event_type: "download_clip",
    resource_type: "clip",
    resource_id: id,
    title_id: (clip.title_id as string | null) ?? undefined,
    tier_at_event: tier,
    metadata: {
      source: "panel",
      token_id: auth.tokenId,
      action,
      ...(campaignId ? { campaign_id: campaignId } : {}),
    },
  });

  // (7) SERVE: 302-redirect to the public R2 URL (honors Range/resume; bytes never
  // flow through the function). Gate + log have already run.
  return NextResponse.redirect(clip.file_url as string, 302);
}
