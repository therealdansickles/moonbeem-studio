// Phase 1D — list CRUD. GET (caller's lists + membership for a title, for the
// list picker), POST (create), PATCH (rename), DELETE (remove). The watchlist
// (kind='watchlist') is excluded from create/rename/delete. All creator-scoped.

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { requireCreatorForLists } from "@/lib/lists/server";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_NAME = 100;
const MAX_DESC = 2000;

export async function GET(request: NextRequest) {
  // Read endpoint — use the chatty (read) limiter, not the write budget.
  const auth = await requireCreatorForLists("me/lists:get", "chattyAuthUser");
  if ("error" in auth) return auth.error;
  const { creatorId } = auth;

  const { searchParams } = new URL(request.url);
  const raw = (searchParams.get("title_id") ?? "").trim();
  const filterTitle = UUID_RE.test(raw) ? raw : null;

  const sb = createServiceRoleClient();
  const { data: lists } = await sb
    .from("user_lists")
    .select("id, name, kind")
    .eq("creator_id", creatorId)
    .order("kind", { ascending: false }) // 'watchlist' before 'list'
    .order("created_at", { ascending: true });
  const listIds = (lists ?? []).map((l) => l.id as string);
  const { data: items } = listIds.length
    ? await sb
        .from("user_list_items")
        .select("list_id, title_id")
        .in("list_id", listIds) // scope by the caller's lists, not item.creator_id
    : { data: [] as { list_id: string; title_id: string | null }[] };

  const countByList = new Map<string, number>();
  const contains = new Set<string>();
  for (const it of items ?? []) {
    const lid = it.list_id as string;
    countByList.set(lid, (countByList.get(lid) ?? 0) + 1);
    if (filterTitle && it.title_id === filterTitle) contains.add(lid);
  }

  return NextResponse.json({
    lists: (lists ?? []).map((l) => ({
      id: l.id as string,
      name: l.name as string,
      kind: l.kind as string,
      item_count: countByList.get(l.id as string) ?? 0,
      contains: contains.has(l.id as string),
    })),
  });
}

export async function POST(request: NextRequest) {
  const auth = await requireCreatorForLists("me/lists");
  if ("error" in auth) return auth.error;
  const { creatorId } = auth;

  let body: { name?: string; description?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });
  if (name.length > MAX_NAME) {
    return NextResponse.json({ error: `name too long (max ${MAX_NAME})` }, { status: 400 });
  }
  const desc =
    typeof body.description === "string" ? body.description.trim() : "";
  if (desc.length > MAX_DESC) {
    return NextResponse.json({ error: `description too long (max ${MAX_DESC})` }, { status: 400 });
  }

  const sb = createServiceRoleClient();
  const { data, error } = await sb
    .from("user_lists")
    .insert({
      creator_id: creatorId,
      name,
      description: desc || null,
      kind: "list",
      source: "native",
      visibility: "public",
    })
    .select("id")
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, id: data?.id ?? null });
}

export async function PATCH(request: NextRequest) {
  const auth = await requireCreatorForLists("me/lists");
  if ("error" in auth) return auth.error;
  const { creatorId } = auth;

  let body: { id?: string; name?: string; description?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const id = (body.id ?? "").trim();
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "invalid id" }, { status: 400 });

  const sb = createServiceRoleClient();
  const { data: list } = await sb
    .from("user_lists")
    .select("id, creator_id, kind")
    .eq("id", id)
    .maybeSingle();
  if (!list || (list.creator_id as string) !== creatorId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if ((list.kind as string) !== "list") {
    return NextResponse.json({ error: "watchlist cannot be renamed" }, { status: 400 });
  }

  const updates: { name?: string; description?: string | null } = {};
  if (body.name !== undefined) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });
    if (name.length > MAX_NAME) {
      return NextResponse.json({ error: `name too long (max ${MAX_NAME})` }, { status: 400 });
    }
    updates.name = name;
  }
  if (body.description !== undefined) {
    const desc = typeof body.description === "string" ? body.description.trim() : "";
    if (desc.length > MAX_DESC) {
      return NextResponse.json({ error: `description too long (max ${MAX_DESC})` }, { status: 400 });
    }
    updates.description = desc || null;
  }
  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  }

  const { error } = await sb
    .from("user_lists")
    .update(updates)
    .eq("id", id)
    .eq("creator_id", creatorId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: NextRequest) {
  const auth = await requireCreatorForLists("me/lists");
  if ("error" in auth) return auth.error;
  const { creatorId } = auth;

  let body: { id?: string };
  try {
    body = (await request.json()) as { id?: string };
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const id = (body.id ?? "").trim();
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "invalid id" }, { status: 400 });

  const sb = createServiceRoleClient();
  const { data: list } = await sb
    .from("user_lists")
    .select("id, creator_id, kind")
    .eq("id", id)
    .maybeSingle();
  if (!list) return NextResponse.json({ ok: true }); // idempotent — already gone
  if ((list.creator_id as string) !== creatorId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if ((list.kind as string) !== "list") {
    return NextResponse.json({ error: "watchlist cannot be deleted" }, { status: 400 });
  }

  // Items are removed by the FK (list_id ON DELETE CASCADE — confirmed by recon).
  const { error } = await sb
    .from("user_lists")
    .delete()
    .eq("id", id)
    .eq("creator_id", creatorId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
