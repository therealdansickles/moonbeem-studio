// Shared post-authentication flow.
//
// This is the EXACT logic that lived inline in auth/callback/route.ts (the
// portion after the session exchange): the deferred title-request replay
// (block A), the atomic welcome-email claim (block B), and the handle-check +
// final redirect resolution (block C). Extracted verbatim so BOTH auth entry
// points behave identically:
//   - /auth/callback  (code flow: exchangeCodeForSession, used by OAuth + old
//                       magic links) calls this after the exchange.
//   - /auth/confirm    (token_hash flow: verifyOtp on explicit user action,
//                       the prefetch-safe magic-link path) calls this after
//                       verifyOtp.
// `supabase` MUST already carry the authenticated session (post-exchange /
// post-verify). This function does not authenticate — it only runs the shared
// post-auth side effects + resolves the redirect.

import { NextResponse, after } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { sendWelcomeEmail } from "@/lib/email/welcome";
import { sendTitleRequestAlert } from "@/lib/email/title-request-alert";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The passthrough params the sign-in flow carries (from the requesting page
// through the email link). In the code flow they arrive as URL query params;
// in the token_hash flow they arrive as form fields — the caller extracts them
// and hands them here, so this helper is transport-agnostic.
export type PostAuthParams = {
  action: string | null;
  title_id: string | null;
  title: string | null;
  redirect_to: string | null;
  request_type: string | null;
};

export async function runPostAuth(args: {
  supabase: SupabaseClient;
  userId: string;
  origin: string;
  userAgent: string | null;
  params: PostAuthParams;
  // Status for the final redirect. Defaults to 307 — the code callback's
  // original behavior (a GET→GET redirect, so unchanged). The token_hash POST
  // path passes 303 so the browser GETs the destination instead of re-POSTing.
  redirectStatus?: 303 | 307;
}): Promise<NextResponse> {
  const { supabase, userId, origin, userAgent, params, redirectStatus = 307 } =
    args;
  const {
    action,
    title_id: titleId,
    title: titleParam,
    redirect_to: redirectTo,
    request_type: requestTypeParam,
  } = params;

  const safeRedirect =
    redirectTo && redirectTo.startsWith("/") ? redirectTo : null;

  // Explicit allowlist of the three valid request types; any other value
  // (including a missing param or legacy 'clips_and_stills') falls back to
  // 'fan_edits'.
  const requestType: "fan_edits" | "clips" | "stills" =
    requestTypeParam === "clips" || requestTypeParam === "stills"
      ? requestTypeParam
      : "fan_edits";

  let resolvedTitleName = titleParam;
  let requestSubmitted = false;

  // Block A — deferred title-request replay.
  if (action === "request_fan_edits" && titleId && UUID_RE.test(titleId)) {
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
        user_id: userId,
        request_type: requestType,
        user_agent: userAgent?.slice(0, 500) ?? null,
      });
    // 23505 = already requested; treat as success
    if (!insertError || insertError.code === "23505") {
      requestSubmitted = true;
    }
    // Only fire the admin alert on a fresh insert (not on 23505 dedup).
    if (!insertError) {
      const alertTitleId = titleId;
      const alertUserId = userId;
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
    .eq("id", userId)
    .maybeSingle();

  // Block B — atomically claim the welcome-email send. Only the request that
  // flips welcome_sent_at NULL → now() actually fires the email. Service-role
  // client to bypass any users-table RLS. Fail-soft — welcome is a
  // nice-to-have, not a sign-in prerequisite.
  try {
    const admin = createServiceRoleClient();
    const { data: claimed } = await admin
      .from("users")
      .update({ welcome_sent_at: new Date().toISOString() })
      .eq("id", userId)
      .is("welcome_sent_at", null)
      .select("id")
      .maybeSingle();
    if (claimed) {
      const claimedUserId = userId;
      after(async () => {
        try {
          const result = await sendWelcomeEmail(claimedUserId);
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

  // Block C — handle-check + final redirect. signin=1 is appended so the
  // GoogleAnalytics client component can fire signin_complete on first render
  // of the destination page, then strip the param via router.replace so
  // back/forward doesn't re-fire.
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
      redirectStatus,
    );
  }

  if (safeRedirect) {
    return NextResponse.redirect(
      `${origin}${safeRedirect}${toastQuery}`,
      redirectStatus,
    );
  }

  return NextResponse.redirect(`${origin}/me${toastQuery}`, redirectStatus);
}
