import { NextResponse, type NextRequest } from "next/server";
import { verifySession } from "@/lib/dal";
import { createClient } from "@/lib/supabase/server";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: NextRequest) {
  const session = await verifySession();

  let body: { title_id?: string; position?: number };
  try {
    body = (await request.json()) as { title_id?: string; position?: number };
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const titleId = (body.title_id ?? "").trim();
  const position = Number(body.position);
  if (!UUID_RE.test(titleId)) {
    return NextResponse.json({ error: "invalid title_id" }, { status: 400 });
  }
  if (!Number.isInteger(position) || position < 1 || position > 12) {
    return NextResponse.json({ error: "invalid position" }, { status: 400 });
  }

  const supabase = await createClient();

  const { data: existing } = await supabase
    .from("user_top_titles")
    .select("id, title_id, position")
    .eq("user_id", session.userId);

  const taken = new Set((existing ?? []).map((r) => r.position as number));
  const titleIds = new Set((existing ?? []).map((r) => r.title_id as string));

  if (titleIds.has(titleId)) {
    return NextResponse.json(
      { error: "Title already in your Top 12." },
      { status: 409 },
    );
  }

  let finalPosition = position;
  if (taken.has(finalPosition)) {
    let next = -1;
    for (let p = 1; p <= 12; p++) {
      if (!taken.has(p)) {
        next = p;
        break;
      }
    }
    if (next === -1) {
      return NextResponse.json(
        { error: "Top 12 is full." },
        { status: 409 },
      );
    }
    finalPosition = next;
  }

  const { error } = await supabase.from("user_top_titles").insert({
    user_id: session.userId,
    title_id: titleId,
    position: finalPosition,
  });

  if (error) {
    if (error.code === "23505") {
      return NextResponse.json(
        { error: "Title already in your Top 12." },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true, position: finalPosition });
}
