import { NextResponse, type NextRequest } from "next/server";
import { requireSuperAdmin } from "@/lib/dal";
import { createClient } from "@/lib/supabase/server";
import { buildPublicUrl } from "@/lib/r2/upload";

type Body = {
  title_id?: string;
  key?: string;
  alt_text?: string | null;
  content_type?: string | null;
  file_size_bytes?: number | null;
  width?: number | null;
  height?: number | null;
};

export async function POST(request: NextRequest) {
  await requireSuperAdmin();

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
    .from("stills")
    .select("display_order")
    .eq("title_id", body.title_id)
    .order("display_order", { ascending: false })
    .limit(1)
    .maybeSingle();
  const nextOrder = (maxRow?.display_order ?? -1) + 1;

  const insert = {
    title_id: body.title_id,
    file_url: buildPublicUrl(body.key),
    alt_text: body.alt_text ?? null,
    content_type: body.content_type ?? null,
    file_size_bytes: body.file_size_bytes ?? null,
    width: body.width ?? null,
    height: body.height ?? null,
    display_order: nextOrder,
  };

  const { data, error } = await supabase
    .from("stills")
    .insert(insert)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json(data, { status: 201 });
}
