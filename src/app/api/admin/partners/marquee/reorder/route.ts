// POST /api/admin/partners/marquee/reorder — super-admin curation of
// the homepage partner logo strip ordering.
//
// Body: { positions: [{ partner_id: uuid, position: 1..N }, ...] }
// Every partner_id must currently be is_marquee_visible=true. This
// route is ordering-only; toggling visibility lives on the PATCH
// /api/admin/partners/[id] endpoint.
//
// Mirrors /api/admin/titles/featured/reorder pattern (two-phase
// shuffle through a TEMP_OFFSET range so a future UNIQUE constraint
// on (marquee_order, is_marquee_visible) wouldn't trip mid-shuffle).

import { NextResponse, type NextRequest } from "next/server";
import { revalidatePath } from "next/cache";
import { requireSuperAdmin } from "@/lib/dal";
import { createServiceRoleClient } from "@/lib/supabase/service";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_ENTRIES = 100;
const TEMP_OFFSET = 10_000;

type Entry = { partner_id: string; position: number };

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
    const pid = (e?.partner_id ?? "").trim();
    const pos = Number(e?.position);
    if (!UUID_RE.test(pid)) {
      return NextResponse.json({ error: "invalid_partner_id" }, { status: 400 });
    }
    if (!Number.isInteger(pos) || pos < 1 || pos > MAX_ENTRIES) {
      return NextResponse.json({ error: "invalid_position" }, { status: 400 });
    }
    if (seenIds.has(pid)) {
      return NextResponse.json({ error: "duplicate_partner_id" }, { status: 400 });
    }
    if (seenPos.has(pos)) {
      return NextResponse.json({ error: "duplicate_position" }, { status: 400 });
    }
    seenIds.add(pid);
    seenPos.add(pos);
  }

  const supabase = createServiceRoleClient();

  const ids = entries.map((e) => e.partner_id);
  const { data: rows, error: readErr } = await supabase
    .from("partners")
    .select("id, is_marquee_visible")
    .in("id", ids);
  if (readErr) {
    return NextResponse.json({ error: readErr.message }, { status: 500 });
  }
  const visibleSet = new Set(
    (rows ?? [])
      .filter((r) => r.is_marquee_visible === true)
      .map((r) => r.id as string),
  );
  for (const id of ids) {
    if (!visibleSet.has(id)) {
      return NextResponse.json(
        { error: "partner_not_marquee_visible", partner_id: id },
        { status: 400 },
      );
    }
  }

  // Phase 1: bump to temp range.
  for (let i = 0; i < entries.length; i++) {
    const { error } = await supabase
      .from("partners")
      .update({ marquee_order: TEMP_OFFSET + i })
      .eq("id", entries[i].partner_id);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
  }
  // Phase 2: settle into requested positions.
  for (const e of entries) {
    const { error } = await supabase
      .from("partners")
      .update({ marquee_order: e.position })
      .eq("id", e.partner_id);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
  }

  revalidatePath("/");
  return NextResponse.json({ success: true });
}
