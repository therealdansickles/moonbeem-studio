import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { runPostAuth } from "@/lib/auth/post-auth";

// Code-exchange auth callback (PKCE `?code=`). Used by Google OAuth and by
// magic links sent with the legacy /auth/v1/verify → ?code redirect (old
// template + any in-flight links). The token_hash magic-link flow lands on
// /auth/confirm instead; both share runPostAuth so behavior is identical.
//
// NOTE: this route DOES auto-exchange on GET — that is correct for OAuth (the
// code is single-use but issued after the user's explicit Google consent, not
// prefetch-exposed) and is unchanged from before the prefetch fix.
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

  return runPostAuth({
    supabase,
    userId: exchange.user.id,
    origin,
    userAgent: request.headers.get("user-agent"),
    params: {
      action: searchParams.get("action"),
      title_id: searchParams.get("title_id"),
      title: searchParams.get("title"),
      redirect_to: searchParams.get("redirect_to"),
      request_type: searchParams.get("request_type"),
    },
  });
}
