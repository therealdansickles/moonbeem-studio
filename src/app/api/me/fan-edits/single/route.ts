// User single-URL fan-edit submission. Verified-tier only. Creates a
// fan_edit row with verification_status='pending' attributed to the
// user's own Moonbeem creator (not stub resolution — users can only
// submit edits on their own behalf).
//
// Mirrors /api/admin/fan-edits/single but:
//   - auth: verifySession + canPerform("upload_fan_edit")
//   - creator_id is always the session user's creator (no override)
//   - verificationStatus = 'pending' (admin queue reviews)
//   - createdByUserId = session.userId

import { NextResponse, type NextRequest } from "next/server";
import { verifySession } from "@/lib/dal";
import { enforce } from "@/lib/ratelimit";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { parseFanEditUrl, resolveFanEditUrl } from "@/lib/fan-edits/url-parser";
import { adminInsertFanEdit } from "@/lib/fan-edits/insert";
import { assertSubmissionOwnership } from "@/lib/fan-edits/platform-ownership";
import { getUserTier } from "@/lib/gating/get-user-tier";
import { canPerform } from "@/lib/gating/can-perform";
import type { FetchEngagementResult } from "@/lib/ensembledata/client";

type Body = {
  url?: string;
  title_id?: string;
  metrics?: FetchEngagementResult | null;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: NextRequest) {
  const session = await verifySession();
  const rl = await enforce(
    "userWrites",
    session.userId,
    "me/fan-edits/single",
  );
  if (!rl.ok) return rl.response;

  const tier = await getUserTier(session.userId);
  const gate = canPerform(tier, "upload_fan_edit");
  if (!gate.allowed) {
    return NextResponse.json(
      { error: gate.reason ?? "not_allowed" },
      { status: 403 },
    );
  }

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (!body.url) {
    return NextResponse.json({ error: "url required" }, { status: 400 });
  }
  if (!body.title_id || !UUID_RE.test(body.title_id)) {
    return NextResponse.json(
      { error: "title_id required (valid UUID)" },
      { status: 400 },
    );
  }

  // Resolve user's own creator. Should always exist for verified
  // users (claim_handle creates the creators row on onboarding); if
  // it's missing, that's a server-state bug worth surfacing.
  const sb = createServiceRoleClient();
  const { data: ownCreator } = await sb
    .from("creators")
    .select("id")
    .eq("user_id", session.userId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!ownCreator?.id) {
    return NextResponse.json(
      { error: "no_creator — claim a Moonbeem handle first" },
      { status: 400 },
    );
  }

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

  // SEC-1 fast pre-check: when the author handle is in the URL
  // (TikTok/Twitter) reject before the insert path with a clean 403. For
  // IG/YT (handle not in URL) this resolves to a platform-level check; the
  // authoritative handle check for IG runs in the insert chokepoint once
  // EnsembleData returns the author handle. Shares the single helper.
  try {
    const pre = await assertSubmissionOwnership(sb, {
      creatorId: ownCreator.id as string,
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
    // creator_socials blip at pre-check — fall through; the insert
    // chokepoint re-runs the check and surfaces any error there.
  }

  const result = await adminInsertFanEdit({
    titleId: body.title_id,
    embedUrl: parsed.normalizedUrl,
    platform: parsed.platform,
    postId: parsed.contentId,
    handle: parsed.handle,
    attributedCreatorId: ownCreator.id as string,
    caption: null,
    prefetchedMetrics: body.metrics ?? null,
    verificationStatus: "pending",
    createdByUserId: session.userId,
  });

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

  return NextResponse.json({
    ok: true,
    fan_edit_id: result.fanEditId,
  });
}
