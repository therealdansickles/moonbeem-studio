// GET /api/clips/[id]/download — gated clip download.
//
// SOFT GATE. This endpoint gates the Download UI flow: it runs the
// tier/quota check, increments the user's lifetime download_clip
// count, and proxies the asset bytes back with an attachment
// disposition. It is NOT byte-level enforcement — the clip's raw R2
// file URL is still shipped to the client (the video player needs
// it), so a determined user can pull the file directly from R2 and
// bypass this path. Hard enforcement (private R2 objects + signed
// URLs for both playback and download) is the Phase 4 backlog item.
//
// Anonymous and signed-in-over-quota users get a 403 with a reason
// the client turns into a GateModal. Super-admins bypass the gate
// (canPerform) and are never counted.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentProfile } from "@/lib/dal";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { getUserTier } from "@/lib/gating/get-user-tier";
import { getUsageCount, incrementUsageCount } from "@/lib/gating/usage-counts";
import { canPerform } from "@/lib/gating/can-perform";
import { logUserEvent } from "@/lib/events/log-event";
import { buildContentDisposition } from "@/lib/r2/upload";
import { enforce, getIp } from "@/lib/ratelimit";

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

  const profile = await getCurrentProfile();
  const userId = profile?.userId ?? null;
  const isSuperAdmin = profile?.role === "super_admin";

  // Light rate limit (anti-hammering) — the gating check below is the
  // real per-user limiter. Keyed on user id when signed in, else IP.
  const rl = await enforce(
    "standardAnon",
    userId ?? getIp(request),
    "clips/[id]/download",
  );
  if (!rl.ok) return rl.response;

  // Gate check — gates the Download UI flow (see file header note).
  const tier = await getUserTier(userId);
  const usage = userId
    ? await getUsageCount(userId, "download_clip")
    : 0;
  const result = canPerform(tier, "download_clip", usage, isSuperAdmin);
  if (!result.allowed) {
    return NextResponse.json(
      { error: result.reason, limit: result.limit, used: result.used },
      { status: 403 },
    );
  }

  const supabase = createServiceRoleClient();
  const { data: clip } = await supabase
    .from("clips")
    .select("file_url, label, title_id")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!clip?.file_url) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // Proxy the bytes so the download goes through this gated path
  // rather than a bare link.
  const assetRes = await fetch(clip.file_url as string);
  if (!assetRes.ok || !assetRes.body) {
    return NextResponse.json({ error: "fetch_failed" }, { status: 502 });
  }

  // user_action_counts tracks lifetime usage for signed-in non-super-
  // admin users across all tiers. Verified users continue
  // incrementing for analytics; the gate (canPerform above) only
  // restricts the signed_in tier — verified users pass freely
  // regardless of count. Super-admins are not counted. Incremented
  // AFTER R2 confirms the asset is fetchable — a 404 / 5xx from R2
  // doesn't cost a quota slot.
  if (userId && !isSuperAdmin) {
    await incrementUsageCount(userId, "download_clip");
  }
  // Full ledger — every signed-in download, super-admins included.
  if (userId) {
    await logUserEvent({
      user_id: userId,
      event_type: "download_clip",
      resource_type: "clip",
      resource_id: id,
      title_id: (clip.title_id as string | null) ?? undefined,
      tier_at_event: tier,
    });
  }

  const label =
    ((clip.label as string | null) ?? "clip")
      .replace(/[^a-z0-9 ._-]/gi, "")
      .trim() || "clip";
  return new Response(assetRes.body, {
    headers: {
      "Content-Type": assetRes.headers.get("content-type") ?? "video/mp4",
      "Content-Disposition": buildContentDisposition(`${label}.mp4`),
      "Cache-Control": "no-store",
    },
  });
}
