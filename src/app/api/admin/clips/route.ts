import { NextResponse, after, type NextRequest } from "next/server";
import { requireSuperAdmin } from "@/lib/dal";
import { createClient } from "@/lib/supabase/server";
import { buildPublicUrl } from "@/lib/r2/upload";
import { notifyTitleRequesters } from "@/lib/notifications/notify-title-requesters";
import { drainQueue } from "@/lib/email-queue";
import { enforce } from "@/lib/ratelimit";

type Body = {
  title_id?: string;
  key?: string;
  label?: string | null;
  content_type?: string | null;
  file_size_bytes?: number | null;
  duration_seconds?: number | null;
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

  if (!body.title_id || !body.key) {
    return NextResponse.json(
      { error: "title_id and key required" },
      { status: 400 },
    );
  }

  const supabase = await createClient();

  const { data: maxRow } = await supabase
    .from("clips")
    .select("display_order")
    .eq("title_id", body.title_id)
    .order("display_order", { ascending: false })
    .limit(1)
    .maybeSingle();
  const nextOrder = (maxRow?.display_order ?? -1) + 1;

  const insert = {
    title_id: body.title_id,
    file_url: buildPublicUrl(body.key),
    label: body.label?.trim() || null,
    content_type: body.content_type ?? null,
    file_size_bytes: body.file_size_bytes ?? null,
    duration_seconds: body.duration_seconds ?? null,
    display_order: nextOrder,
  };

  const { data, error } = await supabase
    .from("clips")
    .insert(insert)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Enqueue synchronously (fast: 1 INSERT). Drain on the after()
  // hot path so the admin upload response returns immediately and
  // delivery happens out-of-band. Cron is the safety net for any
  // queue rows the hot-path drain doesn't reach.
  let enqueuedIds: string[] = [];
  try {
    const notify = await notifyTitleRequesters({
      titleId: body.title_id,
      contentType: "clip",
      contentIds: [data.id as string],
    });
    enqueuedIds = notify.enqueuedIds;
  } catch (err) {
    console.error("notifyTitleRequesters failed (clip)", err);
  }
  if (enqueuedIds.length > 0) {
    after(async () => {
      try {
        await drainQueue({ ids: enqueuedIds, budgetMs: 25_000 });
      } catch (err) {
        console.error("after() drainQueue failed (clip)", err);
      }
    });
  }

  return NextResponse.json(data, { status: 201 });
}
