// Phase 1D — list items. POST adds a title to one of the caller's lists
// (idempotent), DELETE removes it (idempotent). item.creator_id is always the
// parent list's creator, never from the request; the title is gated through
// loadVisibleTitleById (same as diary/ratings).

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { loadVisibleTitleById } from "@/lib/title-access";
import {
  requireCreatorForLists,
  addItemToList,
  removeItemFromList,
} from "@/lib/lists/server";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: NextRequest) {
  const auth = await requireCreatorForLists("me/lists/items");
  if ("error" in auth) return auth.error;
  const { creatorId } = auth;

  let body: { list_id?: string; title_id?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const listId = (body.list_id ?? "").trim();
  const titleId = (body.title_id ?? "").trim();
  if (!UUID_RE.test(listId)) return NextResponse.json({ error: "invalid list_id" }, { status: 400 });
  if (!UUID_RE.test(titleId)) return NextResponse.json({ error: "invalid title_id" }, { status: 400 });

  const sb = createServiceRoleClient();
  const { data: list } = await sb
    .from("user_lists")
    .select("id, creator_id")
    .eq("id", listId)
    .maybeSingle();
  if (!list || (list.creator_id as string) !== creatorId) {
    return NextResponse.json({ error: "list_not_found" }, { status: 404 });
  }

  const title = await loadVisibleTitleById(sb, titleId);
  if (!title) return NextResponse.json({ error: "unknown_title" }, { status: 404 });

  try {
    const { already } = await addItemToList(sb, { creatorId, listId, titleId });
    return NextResponse.json({ ok: true, already });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "add_failed" },
      { status: 500 },
    );
  }
}

export async function DELETE(request: NextRequest) {
  const auth = await requireCreatorForLists("me/lists/items");
  if ("error" in auth) return auth.error;
  const { creatorId } = auth;

  let body: { list_id?: string; title_id?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const listId = (body.list_id ?? "").trim();
  const titleId = (body.title_id ?? "").trim();
  if (!UUID_RE.test(listId)) return NextResponse.json({ error: "invalid list_id" }, { status: 400 });
  if (!UUID_RE.test(titleId)) return NextResponse.json({ error: "invalid title_id" }, { status: 400 });

  const sb = createServiceRoleClient();
  const { data: list } = await sb
    .from("user_lists")
    .select("id, creator_id")
    .eq("id", listId)
    .maybeSingle();
  if (!list || (list.creator_id as string) !== creatorId) {
    return NextResponse.json({ error: "list_not_found" }, { status: 404 });
  }

  await removeItemFromList(sb, listId, titleId); // idempotent
  return NextResponse.json({ ok: true });
}
