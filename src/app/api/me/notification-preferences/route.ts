import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const existing = await supabase
    .from("notification_preferences")
    .select("email_on_title_updates, updated_at")
    .eq("user_id", user.id)
    .maybeSingle();

  if (existing.data) {
    return NextResponse.json({
      email_on_title_updates: existing.data.email_on_title_updates,
      updated_at: existing.data.updated_at,
    });
  }

  const { data: created, error } = await supabase
    .from("notification_preferences")
    .insert({ user_id: user.id })
    .select("email_on_title_updates, updated_at")
    .single();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({
    email_on_title_updates: created.email_on_title_updates,
    updated_at: created.updated_at,
  });
}

type PatchBody = { email_on_title_updates?: unknown };

export async function PATCH(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: PatchBody;
  try {
    body = (await request.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  if (typeof body.email_on_title_updates !== "boolean") {
    return NextResponse.json(
      { error: "email_on_title_updates must be a boolean" },
      { status: 400 },
    );
  }

  const { data, error } = await supabase
    .from("notification_preferences")
    .upsert({
      user_id: user.id,
      email_on_title_updates: body.email_on_title_updates,
    })
    .select("email_on_title_updates, updated_at")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({
    email_on_title_updates: data.email_on_title_updates,
    updated_at: data.updated_at,
  });
}
