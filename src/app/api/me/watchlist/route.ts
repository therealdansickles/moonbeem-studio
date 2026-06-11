// Phase 1D — watchlist toggle. POST adds the title to the caller's watchlist
// (lazy find-or-create), DELETE removes it. Both return { ok, on } for the
// optimistic bookmark toggle. The title is gated via loadVisibleTitleById.

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { loadVisibleTitleById } from "@/lib/title-access";
import {
  requireCreatorForLists,
  findOrCreateWatchlist,
  addItemToList,
  removeItemFromList,
} from "@/lib/lists/server";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: NextRequest) {
  const auth = await requireCreatorForLists("me/watchlist");
  if ("error" in auth) return auth.error;
  const { creatorId } = auth;

  let body: { title_id?: string };
  try {
    body = (await request.json()) as { title_id?: string };
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const titleId = (body.title_id ?? "").trim();
  if (!UUID_RE.test(titleId)) return NextResponse.json({ error: "invalid title_id" }, { status: 400 });

  const sb = createServiceRoleClient();
  const title = await loadVisibleTitleById(sb, titleId);
  if (!title) return NextResponse.json({ error: "unknown_title" }, { status: 404 });

  try {
    const watchlistId = await findOrCreateWatchlist(sb, creatorId);
    await addItemToList(sb, { creatorId, listId: watchlistId, titleId });
    return NextResponse.json({ ok: true, on: true });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "watchlist_failed" },
      { status: 500 },
    );
  }
}

export async function DELETE(request: NextRequest) {
  const auth = await requireCreatorForLists("me/watchlist");
  if ("error" in auth) return auth.error;
  const { creatorId } = auth;

  let body: { title_id?: string };
  try {
    body = (await request.json()) as { title_id?: string };
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const titleId = (body.title_id ?? "").trim();
  if (!UUID_RE.test(titleId)) return NextResponse.json({ error: "invalid title_id" }, { status: 400 });

  const sb = createServiceRoleClient();
  const { data: wl } = await sb
    .from("user_lists")
    .select("id")
    .eq("creator_id", creatorId)
    .eq("kind", "watchlist")
    .maybeSingle();
  if (wl?.id) await removeItemFromList(sb, wl.id as string, titleId); // idempotent
  return NextResponse.json({ ok: true, on: false });
}
