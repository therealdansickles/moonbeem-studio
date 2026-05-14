// GET /api/stills/[id]/download — gated still download.
//
// SOFT GATE. Mirrors /api/clips/[id]/download: runs the tier/quota
// check, increments the user's lifetime download_still count, logs
// a user_events row, and proxies the asset bytes back with an
// attachment disposition. It is NOT byte-level enforcement — the
// still's raw R2 file URL is still shipped to the client (the photo
// grid + lightbox need it), so a direct fetch bypasses this path.
// Hard enforcement (private R2 + signed URLs) is the Phase 4 backlog.
//
// Anonymous and signed-in-over-quota users get a 403 with a reason
// the client turns into a GateModal. Super-admins bypass the gate
// and are not counted — but they ARE logged to user_events.

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

function extFor(contentType: string | null): string {
  switch (contentType) {
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    default:
      return "jpg";
  }
}

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

  const rl = await enforce(
    "standardAnon",
    userId ?? getIp(request),
    "stills/[id]/download",
  );
  if (!rl.ok) return rl.response;

  // Gate check — gates the Download UI flow (see file header note).
  const tier = await getUserTier(userId);
  const usage = userId
    ? await getUsageCount(userId, "download_still")
    : 0;
  const result = canPerform(tier, "download_still", usage, isSuperAdmin);
  if (!result.allowed) {
    return NextResponse.json(
      { error: result.reason, limit: result.limit, used: result.used },
      { status: 403 },
    );
  }

  const supabase = createServiceRoleClient();
  const { data: still } = await supabase
    .from("stills")
    .select("file_url, alt_text, content_type, title_id")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!still?.file_url) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const assetRes = await fetch(still.file_url as string);
  if (!assetRes.ok || !assetRes.body) {
    return NextResponse.json({ error: "fetch_failed" }, { status: 502 });
  }

  // user_action_counts tracks lifetime usage for signed-in non-super-
  // admin users across all tiers. Verified users continue
  // incrementing for analytics; the gate (canPerform above) only
  // restricts the signed_in tier — verified users pass freely
  // regardless of count. Super-admins are not counted.
  if (userId && !isSuperAdmin) {
    await incrementUsageCount(userId, "download_still");
  }
  // Full ledger — every signed-in download, super-admins included.
  if (userId) {
    await logUserEvent({
      user_id: userId,
      event_type: "download_still",
      resource_type: "still",
      resource_id: id,
      title_id: (still.title_id as string | null) ?? undefined,
      tier_at_event: tier,
    });
  }

  const contentType =
    (still.content_type as string | null) ??
    assetRes.headers.get("content-type") ??
    "image/jpeg";
  const label =
    ((still.alt_text as string | null) ?? "still")
      .replace(/[^a-z0-9 ._-]/gi, "")
      .trim() || "still";
  return new Response(assetRes.body, {
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": buildContentDisposition(
        `${label}.${extFor(contentType)}`,
      ),
      "Cache-Control": "no-store",
    },
  });
}
