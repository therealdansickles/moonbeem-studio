// POST /api/panel/fan-edits — Bearer-gated fan-edit submission for the Premiere
// panel (publish-back). A verified creator posts a finished edit to their social
// platform, then submits that URL via the panel; it lands as a fan_edit attributed
// to them, EXACTLY as a web submission would.
//
// ADDITIVE (Option B): this is a NEW Bearer-only route that calls the EXISTING
// adminInsertFanEdit chokepoint directly. It does NOT modify the live web route
// (/api/me/fan-edits/single) and does NOT extract a shared core (banked). The brief
// route-glue duplication (parse + own-creator pre-check) is accepted.
//
// SEC-1 PARITY (correctness-critical): platform-specific verification fires
// IDENTICALLY to a web submission because we route through adminInsertFanEdit with
// verificationStatus:"pending" + attributedCreatorId — the exact condition under
// which the chokepoint runs assertSubmissionOwnership. There is NO auto_verified
// path here, NO direct fan_edits write, and NO SEC-1-skipping flag. A panel
// submission is exactly as strict as a web submission (NOT the download's looser
// any-verified-social gate).
//
// MONEY BOUNDARY: content-only. Imports token auth, the fan-edit insert chokepoint
// + SEC-1 pre-check, the URL parser, the tier gate, the rate-limiter, and the
// service client. NO earnings/metering/withdraw/campaign-billing/stripe code. The
// fan_edit it writes flows to money LATER via the same cron metering rail a web
// submission feeds — this route never invokes money code.

import { NextResponse, type NextRequest } from "next/server";
import { verifyApiToken, requireScope } from "@/lib/api-tokens/verify";
import { enforce, getIp } from "@/lib/ratelimit";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { parseFanEditUrl, resolveFanEditUrl } from "@/lib/fan-edits/url-parser";
import { adminInsertFanEdit } from "@/lib/fan-edits/insert";
import { assertSubmissionOwnership } from "@/lib/fan-edits/platform-ownership";
import { getUserTier } from "@/lib/gating/get-user-tier";
import { canPerform } from "@/lib/gating/can-perform";

type Body = {
  url?: string;
  title_id?: string;
  campaign_id?: string;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: NextRequest) {
  // (1) IP-KEYED RATE LIMIT — BEFORE the token lookup (security must-do #1).
  // Mirrors the panel clip-download route: a garbage Bearer hits an IP cap before
  // the SHA-256 + token-table lookup.
  const rl = await enforce("tightAnon", getIp(request), "panel/fan-edits");
  if (!rl.ok) return rl.response;

  // (2) Authenticate by Bearer API token. verifyApiToken resolves the SAME creator
  // a cookie session would (creators WHERE user_id AND deleted_at IS NULL).
  const auth = await verifyApiToken(request);
  if (!auth) {
    return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  }

  // (3) Authorize the action. fan_edit:submit is in the content-only scope set.
  const denied = requireScope(auth, "fan_edit:submit");
  if (denied) return denied;

  // (4) Per-creator rate limit — a submission burns an EnsembleData credit, so
  // cap it per creator (in addition to verifyApiToken's internal per-user limit).
  const creatorRl = await enforce(
    "userWrites",
    auth.userId,
    "panel/fan-edits/submit",
  );
  if (!creatorRl.ok) return creatorRl.response;

  // (5) TIER GATE — first verification layer (same as web): upload_fan_edit is
  // verified-tier-only. (SEC-1 in the chokepoint is the second, platform-specific
  // layer.)
  const tier = await getUserTier(auth.userId);
  const gate = canPerform(tier, "upload_fan_edit");
  if (!gate.allowed) {
    return NextResponse.json(
      { error: gate.reason ?? "not_allowed" },
      { status: 403 },
    );
  }

  // (6) Parse body. url + title_id required; campaign_id optional.
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (!body.url || typeof body.url !== "string") {
    return NextResponse.json({ error: "url required" }, { status: 400 });
  }
  if (!body.title_id || !UUID_RE.test(body.title_id)) {
    return NextResponse.json(
      { error: "title_id required (valid UUID)" },
      { status: 400 },
    );
  }
  // campaign_id: accepted + validated for API forward-compat (the panel may pass
  // its campaign context), but NOT persisted. The web submission path logs no
  // user_event and fan_edits has no campaign_id column; we match web exactly
  // rather than add panel-only logging or change the chokepoint. Reject only if
  // present-but-malformed so the panel gets a clean signal.
  if (
    body.campaign_id !== undefined &&
    body.campaign_id !== null &&
    !UUID_RE.test(body.campaign_id)
  ) {
    return NextResponse.json(
      { error: "campaign_id must be a valid UUID" },
      { status: 400 },
    );
  }

  // (7) Resolve + parse the URL (the accepted brief glue duplication with web).
  const resolved = await resolveFanEditUrl(body.url);
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.reason }, { status: 400 });
  }
  const parsed = parseFanEditUrl(resolved.url);
  if (!parsed) {
    return NextResponse.json(
      { error: "URL not recognized for any supported platform" },
      { status: 400 },
    );
  }

  // (8) SEC-1 FAST PRE-CHECK (same as web): cheap 403 before the EnsembleData
  // spend when the author handle is in the URL (TikTok/Twitter). For IG/YT this is
  // a platform-level check; the AUTHORITATIVE SEC-1 gate re-runs inside
  // adminInsertFanEdit once metrics return. A creator_socials blip falls through —
  // the chokepoint re-runs the check and surfaces any error there.
  const sb = createServiceRoleClient();
  try {
    const pre = await assertSubmissionOwnership(sb, {
      creatorId: auth.creatorId,
      platform: parsed.platform,
      authorHandle: parsed.handle,
    });
    if (!pre.ok) {
      return NextResponse.json(
        {
          error: pre.reason,
          detail: pre.reason === "handle_mismatch" ? pre.detail : undefined,
        },
        { status: 403 },
      );
    }
  } catch {
    // fall through; the insert chokepoint re-runs SEC-1 authoritatively.
  }

  // (9) Insert via the shared chokepoint. verificationStatus:"pending" +
  // attributedCreatorId is the condition that fires SEC-1 inside adminInsertFanEdit
  // — identical rigor to a web submission. prefetchedMetrics:null lets the
  // chokepoint fetch EnsembleData itself (the panel skips the fetch-metadata
  // pre-call).
  const result = await adminInsertFanEdit({
    titleId: body.title_id,
    embedUrl: parsed.normalizedUrl,
    platform: parsed.platform,
    postId: parsed.contentId,
    handle: parsed.handle,
    attributedCreatorId: auth.creatorId,
    caption: null,
    prefetchedMetrics: null,
    verificationStatus: "pending",
    createdByUserId: auth.userId,
  });

  // (10) Map errors identically to the web route.
  if (!result.ok) {
    const status =
      result.kind === "duplicate"
        ? 409
        : result.kind === "ownership_failed"
          ? 403
          : 400;
    return NextResponse.json(
      { error: result.reason, kind: result.kind, detail: result.detail },
      { status },
    );
  }

  return NextResponse.json({ ok: true, fan_edit_id: result.fanEditId });
}
