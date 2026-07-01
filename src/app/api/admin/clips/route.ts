import { NextResponse, after, type NextRequest } from "next/server";
import { requireSuperAdmin } from "@/lib/dal";
import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { buildPublicUrl } from "@/lib/r2/upload";
import { notifyTitleRequesters } from "@/lib/notifications/notify-title-requesters";
import { drainQueue } from "@/lib/email-queue";
import { fulfillTitleRequestsForContent } from "@/lib/title-requests/fulfill-on-content-upload";
import { enforce } from "@/lib/ratelimit";

// Batched admin clip upload. One POST per batch = one notify call per
// requester = one email per (requester, batch). Pre-2026-05-15 this
// route took one clip per POST, so a 5-clip batch fan-fired 5 separate
// emails to each requester — the fix is to accept items[] and bulk-
// insert in a single request.

type Item = {
  key: string;
  label?: string | null;
  content_type?: string | null;
  file_size_bytes?: number | null;
  duration_seconds?: number | null;
};

type Body = {
  title_id?: string;
  items?: Item[];
};

export async function POST(request: NextRequest) {
  const session = await requireSuperAdmin();
  const limit = await enforce("admin", session.userId, "admin/clips");
  if (!limit.ok) return limit.response;

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  if (!body.title_id) {
    return NextResponse.json({ error: "title_id required" }, { status: 400 });
  }
  const items = Array.isArray(body.items) ? body.items : [];
  if (items.length === 0) {
    return NextResponse.json(
      { error: "items[] required (at least one)" },
      { status: 400 },
    );
  }
  for (const item of items) {
    if (!item.key) {
      return NextResponse.json(
        { error: "each item requires key" },
        { status: 400 },
      );
    }
  }

  const supabase = await createClient();

  // Single max-order read, then offset each item.
  const { data: maxRow } = await supabase
    .from("clips")
    .select("display_order")
    .eq("title_id", body.title_id)
    .order("display_order", { ascending: false })
    .limit(1)
    .maybeSingle();
  const baseOrder = (maxRow?.display_order ?? -1) + 1;

  const inserts = items.map((item, i) => ({
    title_id: body.title_id,
    file_url: buildPublicUrl(item.key),
    label: item.label?.trim() || null,
    content_type: item.content_type ?? null,
    file_size_bytes: item.file_size_bytes ?? null,
    duration_seconds: item.duration_seconds ?? null,
    display_order: baseOrder + i,
  }));

  const { data, error } = await supabase
    .from("clips")
    .insert(inserts)
    .select();

  if (error || !data) {
    return NextResponse.json(
      { error: error?.message ?? "insert failed" },
      { status: 500 },
    );
  }

  const newIds = data.map((d) => d.id as string);

  // Mark every open 'clips' request for this title as fulfilled (2026-07-01
  // split: a clip upload closes 'clips' requests only). Service-role because
  // admin users don't own these rows. Fire-and-forget via the shared helper —
  // a fulfillment failure must not break the upload.
  const admin = createServiceRoleClient();
  await fulfillTitleRequestsForContent(admin, body.title_id, "clips");

  // One notify call for the whole batch — each requester gets one
  // email row referencing all N clip ids via content_ids[].
  let enqueuedIds: string[] = [];
  try {
    const notify = await notifyTitleRequesters({
      titleId: body.title_id,
      contentType: "clip",
      contentIds: newIds,
    });
    enqueuedIds = notify.enqueuedIds;
  } catch (err) {
    console.error("notifyTitleRequesters failed (clip batch)", err);
  }
  if (enqueuedIds.length > 0) {
    after(async () => {
      try {
        await drainQueue({ ids: enqueuedIds, budgetMs: 25_000 });
      } catch (err) {
        console.error("after() drainQueue failed (clip batch)", err);
      }
    });
  }

  return NextResponse.json({ clips: data }, { status: 201 });
}
