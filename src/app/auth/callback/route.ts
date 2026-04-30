import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");

  if (!code) {
    return NextResponse.redirect(`${origin}/login?error=auth_failed`);
  }

  const supabase = await createClient();
  const { data: exchange, error } =
    await supabase.auth.exchangeCodeForSession(code);

  if (error || !exchange.user) {
    return NextResponse.redirect(`${origin}/login?error=auth_failed`);
  }

  const { data: profile } = await supabase
    .from("users")
    .select("handle")
    .eq("id", exchange.user.id)
    .maybeSingle();

  if (!profile?.handle) {
    return NextResponse.redirect(`${origin}/onboarding/handle`);
  }

  return NextResponse.redirect(`${origin}/me`);
}
