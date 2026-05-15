import { NextResponse, after, type NextRequest } from "next/server";
import { requireSuperAdmin } from "@/lib/dal";
import { createClient } from "@/lib/supabase/server";
import { buildPublicUrl } from "@/lib/r2/upload";
import { notifyTitleRequesters } from "@/lib/notifications/notify-title-requesters";
import { drainQueue } from "@/lib/email-queue";
import { enforce } from "@/lib/ratelimit";

// Batched admin still upload — mirrors /api/admin/clips. See that
// route for the batching rationale.

type Item = {
  key: string;
  alt_text?: string | null;
  content_type?: string | null;
  file_size_bytes?: number | null;
  width?: number | null;
  height?: number | null;
};

type Body = {
  title_id?: string;
  items?: Item[];
};

export async function POST(request: NextRequest) {
  const session = await requireSuperAdmin();
  const limit = await enforce("admin", session.userId, "admin/stills");
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

  const { data: maxRow } = await supabase
    .from("stills")
    .select("display_order")
    .eq("title_id", body.title_id)
    .order("display_order", { ascending: false })
    .limit(1)
    .maybeSingle();
  const baseOrder = (maxRow?.display_order ?? -1) + 1;

  const inserts = items.map((item, i) => ({
    title_id: body.title_id,
    file_url: buildPublicUrl(item.key),
    alt_text: item.alt_text?.trim() || null,
    content_type: item.content_type ?? null,
    file_size_bytes: item.file_size_bytes ?? null,
    width: item.width ?? null,
    height: item.height ?? null,
    display_order: baseOrder + i,
  }));

  const { data, error } = await supabase
    .from("stills")
    .insert(inserts)
    .select();

  if (error || !data) {
    return NextResponse.json(
      { error: error?.message ?? "insert failed" },
      { status: 500 },
    );
  }

  const newIds = data.map((d) => d.id as string);

  let enqueuedIds: string[] = [];
  try {
    const notify = await notifyTitleRequesters({
      titleId: body.title_id,
      contentType: "still",
      contentIds: newIds,
    });
    enqueuedIds = notify.enqueuedIds;
  } catch (err) {
    console.error("notifyTitleRequesters failed (still batch)", err);
  }
  if (enqueuedIds.length > 0) {
    after(async () => {
      try {
        await drainQueue({ ids: enqueuedIds, budgetMs: 25_000 });
      } catch (err) {
        console.error("after() drainQueue failed (still batch)", err);
      }
    });
  }

  return NextResponse.json({ stills: data }, { status: 201 });
}
