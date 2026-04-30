import { NextResponse, type NextRequest } from "next/server";
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
  let body: { handle?: string };
  try {
    body = (await request.json()) as { handle?: string };
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const handle = (body.handle ?? "").trim().toLowerCase();
  if (!HANDLE_RE.test(handle)) {
    return NextResponse.json({ available: false, reason: "invalid" });
  }
  if (RESERVED.has(handle)) {
    return NextResponse.json({ available: false, reason: "reserved" });
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("users")
    .select("id")
    .eq("handle", handle)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ available: !data });
}
