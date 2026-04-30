import { NextResponse, type NextRequest } from "next/server";
import { verifySession } from "@/lib/dal";
import { createClient } from "@/lib/supabase/server";

const HANDLE_RE = /^[a-z0-9_]{3,30}$/;
const RESERVED = new Set([
  "admin",
  "api",
  "auth",
  "browse",
  "login",
  "logout",
  "me",
  "moonbeem",
  "onboarding",
  "search",
  "settings",
  "signup",
  "support",
  "t",
  "title",
  "titles",
]);

export async function POST(request: NextRequest) {
  const session = await verifySession();

  let body: { handle?: string };
  try {
    body = (await request.json()) as { handle?: string };
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const handle = (body.handle ?? "").trim().toLowerCase();
  if (!HANDLE_RE.test(handle)) {
    return NextResponse.json(
      { error: "Handle must be 3-30 chars: a-z, 0-9, underscore." },
      { status: 400 },
    );
  }
  if (RESERVED.has(handle)) {
    return NextResponse.json({ error: "Handle reserved." }, { status: 400 });
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("users")
    .update({ handle })
    .eq("id", session.userId);

  if (error) {
    if (error.code === "23505") {
      return NextResponse.json({ error: "Handle taken." }, { status: 409 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
