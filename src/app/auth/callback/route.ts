import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

  const action = searchParams.get("action");
  const titleId = searchParams.get("title_id");
  const titleParam = searchParams.get("title");
  const redirectTo = searchParams.get("redirect_to");
  const requestTypeParam = searchParams.get("request_type");
  const safeRedirect =
    redirectTo && redirectTo.startsWith("/") ? redirectTo : null;

  const requestType: "fan_edits" | "clips_and_stills" =
    requestTypeParam === "clips_and_stills" ? "clips_and_stills" : "fan_edits";

  let resolvedTitleName = titleParam;
  let requestSubmitted = false;

  if (
    action === "request_fan_edits" &&
    titleId &&
    UUID_RE.test(titleId)
  ) {
    if (!resolvedTitleName) {
      const { data: t } = await supabase
        .from("titles")
        .select("title")
        .eq("id", titleId)
        .maybeSingle();
      if (t?.title) resolvedTitleName = t.title as string;
    }

    const { error: insertError } = await supabase
      .from("title_requests")
      .insert({
        title_id: titleId,
        user_id: exchange.user.id,
        request_type: requestType,
        user_agent: request.headers.get("user-agent")?.slice(0, 500) ?? null,
      });
    // 23505 = already requested; treat as success
    if (!insertError || insertError.code === "23505") {
      requestSubmitted = true;
    }
  }

  const { data: profile } = await supabase
    .from("users")
    .select("handle")
    .eq("id", exchange.user.id)
    .maybeSingle();

  const toastQuery = (() => {
    const p = new URLSearchParams();
    if (requestSubmitted) {
      p.set("request_submitted", "1");
      if (resolvedTitleName) p.set("title", resolvedTitleName);
    }
    const s = p.toString();
    return s ? `?${s}` : "";
  })();

  if (!profile?.handle) {
    const onboardParams = new URLSearchParams();
    if (safeRedirect) onboardParams.set("next", safeRedirect);
    if (requestSubmitted) {
      onboardParams.set("request_submitted", "1");
      if (resolvedTitleName) onboardParams.set("title", resolvedTitleName);
    }
    const onboardQuery = onboardParams.size
      ? `?${onboardParams.toString()}`
      : "";
    return NextResponse.redirect(
      `${origin}/onboarding/handle${onboardQuery}`,
    );
  }

  if (safeRedirect) {
    return NextResponse.redirect(`${origin}${safeRedirect}${toastQuery}`);
  }

  return NextResponse.redirect(`${origin}/me${toastQuery}`);
}
