import { NextResponse, type NextRequest } from "next/server";
import { verifySession } from "@/lib/dal";
import { createClient } from "@/lib/supabase/server";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Entry = { title_id: string; position: number };

export async function POST(request: NextRequest) {
  const session = await verifySession();

  let body: { positions?: Entry[] };
  try {
    body = (await request.json()) as { positions?: Entry[] };
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const entries = Array.isArray(body.positions) ? body.positions : [];
  if (entries.length === 0) {
    return NextResponse.json({ error: "positions required" }, { status: 400 });
  }
  if (entries.length > 12) {
    return NextResponse.json(
      { error: "too many entries" },
      { status: 400 },
    );
  }

  const seenTitleIds = new Set<string>();
  const seenPositions = new Set<number>();
  for (const e of entries) {
    const tid = (e?.title_id ?? "").trim();
    const pos = Number(e?.position);
    if (!UUID_RE.test(tid)) {
      return NextResponse.json({ error: "invalid title_id" }, { status: 400 });
    }
    if (!Number.isInteger(pos) || pos < 1 || pos > 12) {
      return NextResponse.json({ error: "invalid position" }, { status: 400 });
    }
    if (seenTitleIds.has(tid)) {
      return NextResponse.json(
        { error: "duplicate title_id" },
        { status: 400 },
      );
    }
    if (seenPositions.has(pos)) {
      return NextResponse.json(
        { error: "duplicate position" },
        { status: 400 },
      );
    }
    seenTitleIds.add(tid);
    seenPositions.add(pos);
  }

  const supabase = await createClient();

  const { data: existing, error: fetchErr } = await supabase
    .from("user_top_titles")
    .select("id, title_id, position")
    .eq("user_id", session.userId);
  if (fetchErr) {
    return NextResponse.json({ error: fetchErr.message }, { status: 500 });
  }
  const byTitleId = new Map(
    (existing ?? []).map((r) => [r.title_id as string, r.id as string]),
  );

  // Two-phase update to dodge the unique(user_id, position) constraint
  // mid-shuffle: bump everything to a high temporary range first, then
  // settle into the requested positions.
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const id = byTitleId.get(e.title_id);
    if (!id) continue;
    const { error } = await supabase
      .from("user_top_titles")
      .update({ position: 100 + i })
      .eq("id", id);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
  }

  for (const e of entries) {
    const id = byTitleId.get(e.title_id);
    if (!id) continue;
    const { error } = await supabase
      .from("user_top_titles")
      .update({ position: e.position })
      .eq("id", id);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
  }

  return NextResponse.json({ success: true });
}
