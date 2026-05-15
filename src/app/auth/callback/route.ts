import { NextResponse, after } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { sendWelcomeEmail } from "@/lib/email/welcome";
import { sendTitleRequestAlert } from "@/lib/email/title-request-alert";

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
    // Only fire the admin alert on a fresh insert (not on 23505 dedup).
    if (!insertError) {
      const alertTitleId = titleId;
      const alertUserId = exchange.user.id;
      const alertRequestType = requestType;
      after(async () => {
        try {
          const res = await sendTitleRequestAlert({
            titleId: alertTitleId,
            requesterUserId: alertUserId,
            requestType: alertRequestType,
          });
          if (!res.ok) {
            console.warn("[title-request-alert] send failed", res.error);
          }
        } catch (err) {
          console.warn("[title-request-alert] send threw", err);
        }
      });
    }
  }

  const { data: profile } = await supabase
    .from("users")
    .select("handle")
    .eq("id", exchange.user.id)
    .maybeSingle();

  // Atomically claim the welcome-email send. Only the request that
  // flips welcome_sent_at NULL → now() actually fires the email.
  // Service-role client to bypass any users-table RLS. Fail-soft —
  // welcome is a nice-to-have, not a sign-in prerequisite.
  try {
    const admin = createServiceRoleClient();
    const { data: claimed } = await admin
      .from("users")
      .update({ welcome_sent_at: new Date().toISOString() })
      .eq("id", exchange.user.id)
      .is("welcome_sent_at", null)
      .select("id")
      .maybeSingle();
    if (claimed) {
      const userId = exchange.user.id;
      after(async () => {
        try {
          const result = await sendWelcomeEmail(userId);
          if (!result.ok) {
            console.warn("[welcome] send failed", result.error);
          }
        } catch (err) {
          console.warn("[welcome] send threw", err);
        }
      });
    }
  } catch (err) {
    console.warn("[welcome] claim failed", err);
  }

  // signin=1 is appended to the post-auth redirect so the
  // GoogleAnalytics client component can fire signin_complete on
  // first render of the destination page, then strip the param via
  // router.replace so back/forward doesn't re-fire.
  const toastQuery = (() => {
    const p = new URLSearchParams();
    if (requestSubmitted) {
      p.set("request_submitted", "1");
      if (resolvedTitleName) p.set("title", resolvedTitleName);
    }
    p.set("signin", "1");
    return `?${p.toString()}`;
  })();

  if (!profile?.handle) {
    const onboardParams = new URLSearchParams();
    if (safeRedirect) onboardParams.set("next", safeRedirect);
    if (requestSubmitted) {
      onboardParams.set("request_submitted", "1");
      if (resolvedTitleName) onboardParams.set("title", resolvedTitleName);
    }
    onboardParams.set("signin", "1");
    return NextResponse.redirect(
      `${origin}/onboarding/handle?${onboardParams.toString()}`,
    );
  }

  if (safeRedirect) {
    return NextResponse.redirect(`${origin}${safeRedirect}${toastQuery}`);
  }

  return NextResponse.redirect(`${origin}/me${toastQuery}`);
}
