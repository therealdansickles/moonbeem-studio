// POST /api/titles/[id]/download-all — authorize + manifest for the
// "download all clips" / "download all stills" action. Body: { type }.
//
// GATE + HAND-OFF (mirrors the panel clip route's posture): verify the caller
// may bulk-download (download_all_zip = verified-only), log one user_events row
// per included item for attribution parity with single downloads, then return
// the list of PUBLIC R2 URLs + derived filenames. The bytes NEVER flow through
// this function — the client downloads clips sequentially straight from R2
// (their Content-Disposition already forces an attachment save) and zips stills
// in the browser. Same SOFT-GATE posture as the single-item routes: file_url is
// already public (the /t/[slug] page ships it), so returning it exposes nothing
// new; this is a UI/quota/attribution gate, not byte-level enforcement (private
// R2 + signed URLs is the Phase 4 backlog).
//
// No usage-count decrement: download_all_zip is verified-only and verified is
// unlimited on download_clip/still, so there is no quota to spend.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentProfile } from "@/lib/dal";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { getUserTier } from "@/lib/gating/get-user-tier";
import { canPerform } from "@/lib/gating/can-perform";
import { logUserEvent } from "@/lib/events/log-event";
import { enforce, getIp } from "@/lib/ratelimit";
import { listClipsForTitle, listStillsForTitle } from "@/lib/queries/titles";
import { filenameForItem } from "@/lib/downloads/bundle";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type BundleItem = {
  id: string;
  url: string;
  filename: string;
  size: number | null;
  content_type: string | null;
};

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  let body: { type?: unknown };
  try {
    body = (await request.json()) as { type?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const type = body?.type;
  if (type !== "clips" && type !== "stills") {
    return NextResponse.json({ error: "invalid_type" }, { status: 400 });
  }

  const profile = await getCurrentProfile();
  const userId = profile?.userId ?? null;
  const isSuperAdmin = profile?.role === "super_admin";

  // Light anti-hammering rate limit (one call per bundle; the byte transfers
  // go direct to R2, so this function is never the bottleneck). Keyed on user
  // id when signed in, else IP.
  const rl = await enforce(
    "standardAnon",
    userId ?? getIp(request),
    "titles/[id]/download-all",
  );
  if (!rl.ok) return rl.response;

  // Gate — verified-only. Anonymous -> auth_required, signed_in ->
  // verification_required (the client turns either into the GateModal).
  const tier = await getUserTier(userId);
  const gate = canPerform(tier, "download_all_zip", 0, isSuperAdmin);
  if (!gate.allowed) {
    return NextResponse.json({ error: gate.reason }, { status: 403 });
  }

  const supabase = createServiceRoleClient();
  const items: BundleItem[] = [];
  if (type === "clips") {
    for (const c of await listClipsForTitle(supabase, id)) {
      if (!c.file_url) continue;
      items.push({
        id: c.id,
        url: c.file_url,
        filename: filenameForItem(c.label, c.content_type, "clip", "mp4"),
        size: c.file_size_bytes,
        content_type: c.content_type,
      });
    }
  } else {
    for (const s of await listStillsForTitle(supabase, id)) {
      if (!s.file_url) continue;
      items.push({
        id: s.id,
        url: s.file_url,
        filename: filenameForItem(s.alt_text, s.content_type, "still", "jpg"),
        size: s.file_size_bytes,
        content_type: s.content_type,
      });
    }
  }

  if (items.length === 0) {
    return NextResponse.json({ error: "empty" }, { status: 404 });
  }

  // Per-item ledger — one row per included item, exactly as a single download
  // logs, so the fan-edit-funnel analytics read identically whether a creator
  // pulled one item or the whole set. No bundle event type.
  if (userId) {
    const event_type = type === "clips" ? "download_clip" : "download_still";
    const resource_type = type === "clips" ? "clip" : "still";
    await Promise.all(
      items.map((it) =>
        logUserEvent({
          user_id: userId,
          event_type,
          resource_type,
          resource_id: it.id,
          title_id: id,
          tier_at_event: tier,
        }),
      ),
    );
  }

  return NextResponse.json({ items });
}
