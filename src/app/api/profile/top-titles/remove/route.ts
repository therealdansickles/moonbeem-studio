import { NextResponse, type NextRequest } from "next/server";
import { verifySession } from "@/lib/dal";
import { createClient } from "@/lib/supabase/server";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: NextRequest) {
  const session = await verifySession();

  let body: { title_id?: string };
  try {
    body = (await request.json()) as { title_id?: string };
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const titleId = (body.title_id ?? "").trim();
  if (!UUID_RE.test(titleId)) {
    return NextResponse.json({ error: "invalid title_id" }, { status: 400 });
  }

  const supabase = await createClient();

  const { data: existing, error: fetchErr } = await supabase
    .from("user_top_titles")
    .select("id, title_id, position")
    .eq("user_id", session.userId)
    .order("position", { ascending: true });
  if (fetchErr) {
    return NextResponse.json({ error: fetchErr.message }, { status: 500 });
  }

  const target = (existing ?? []).find((r) => r.title_id === titleId);
  if (!target) {
    return NextResponse.json({ success: true });
  }

  const { error: delErr } = await supabase
    .from("user_top_titles")
    .delete()
    .eq("user_id", session.userId)
    .eq("title_id", titleId);
  if (delErr) {
    return NextResponse.json({ error: delErr.message }, { status: 500 });
  }

  // Re-pack remaining positions to be contiguous 1..N. Bump to high range
  // first to dodge the unique(user_id, position) constraint during the swap.
  const remaining = (existing ?? [])
    .filter((r) => r.title_id !== titleId)
    .sort((a, b) => (a.position as number) - (b.position as number));

  for (let i = 0; i < remaining.length; i++) {
    const r = remaining[i];
    const tempPos = 100 + i;
    const { error } = await supabase
      .from("user_top_titles")
      .update({ position: tempPos })
      .eq("id", r.id);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
  }
  for (let i = 0; i < remaining.length; i++) {
    const r = remaining[i];
    const finalPos = i + 1;
    const { error } = await supabase
      .from("user_top_titles")
      .update({ position: finalPos })
      .eq("id", r.id);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
  }

  return NextResponse.json({ success: true });
}
