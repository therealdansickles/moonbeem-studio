// POST /api/admin/titles/featured/reorder — super-admin curation of the
// homepage Featured carousel ordering.
//
// Body: { positions: [{ title_id: uuid, position: 1..N }, ...] }
// Each title_id must already be is_featured=true. We don't add/remove
// titles here — that's the is_featured PATCH on /api/admin/titles/[slug].
// This route only resequences featured_order.
//
// Mirrors /api/profile/top-titles/reorder's two-phase shuffle (bump to
// a high temporary range then settle into final positions). Profile
// uses that to dodge a UNIQUE constraint; titles.featured_order has no
// UNIQUE today, but matching the pattern keeps the codebase one-of-one
// and avoids transient invariant gaps if a UNIQUE is added later.

import { NextResponse, type NextRequest } from "next/server";
import { revalidatePath } from "next/cache";
import { requireSuperAdmin } from "@/lib/dal";
import { createServiceRoleClient } from "@/lib/supabase/service";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_ENTRIES = 100;
const TEMP_OFFSET = 10_000;

type Entry = { title_id: string; position: number };

export async function POST(request: NextRequest) {
  await requireSuperAdmin();

  let body: { positions?: Entry[] };
  try {
    body = (await request.json()) as { positions?: Entry[] };
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const entries = Array.isArray(body.positions) ? body.positions : [];
  if (entries.length === 0) {
    return NextResponse.json({ error: "positions_required" }, { status: 400 });
  }
  if (entries.length > MAX_ENTRIES) {
    return NextResponse.json({ error: "too_many_entries" }, { status: 400 });
  }

  const seenIds = new Set<string>();
  const seenPos = new Set<number>();
  for (const e of entries) {
    const tid = (e?.title_id ?? "").trim();
    const pos = Number(e?.position);
    if (!UUID_RE.test(tid)) {
      return NextResponse.json({ error: "invalid_title_id" }, { status: 400 });
    }
    if (!Number.isInteger(pos) || pos < 1 || pos > MAX_ENTRIES) {
      return NextResponse.json({ error: "invalid_position" }, { status: 400 });
    }
    if (seenIds.has(tid)) {
      return NextResponse.json({ error: "duplicate_title_id" }, { status: 400 });
    }
    if (seenPos.has(pos)) {
      return NextResponse.json({ error: "duplicate_position" }, { status: 400 });
    }
    seenIds.add(tid);
    seenPos.add(pos);
  }

  const supabase = createServiceRoleClient();

  // All listed titles must currently be is_featured. Reorder is
  // ordering-only — toggling is_featured lives on the PATCH endpoint.
  const ids = entries.map((e) => e.title_id);
  const { data: featured, error: readErr } = await supabase
    .from("titles")
    .select("id, is_featured")
    .in("id", ids);
  if (readErr) {
    return NextResponse.json({ error: readErr.message }, { status: 500 });
  }
  const featuredSet = new Set(
    (featured ?? [])
      .filter((r) => r.is_featured === true)
      .map((r) => r.id as string),
  );
  for (const id of ids) {
    if (!featuredSet.has(id)) {
      return NextResponse.json(
        { error: "title_not_featured", title_id: id },
        { status: 400 },
      );
    }
  }

  // Phase 1: bump every entry to a temporary high-range value so the
  // final write can collide-free assign 1..N.
  for (let i = 0; i < entries.length; i++) {
    const { error } = await supabase
      .from("titles")
      .update({ featured_order: TEMP_OFFSET + i })
      .eq("id", entries[i].title_id);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
  }
  // Phase 2: settle into the requested positions.
  for (const e of entries) {
    const { error } = await supabase
      .from("titles")
      .update({ featured_order: e.position })
      .eq("id", e.title_id);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
  }

  revalidatePath("/");
  return NextResponse.json({ success: true });
}
