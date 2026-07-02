// Prefetch-safe magic-link confirmation.
//
// The magic-link email (once the template is switched — a LATER, dashboard-only
// step) points here with a token_hash instead of the auto-consuming
// /auth/v1/verify URL. The crux:
//   - GET renders a "Confirm sign-in" button and NOTHING ELSE. It does NOT call
//     verifyOtp, does NOT consume the token, does NOT create a session. A Gmail/
//     Outlook link scanner that prefetches the URL performs this GET, loads the
//     harmless page, and burns no token.
//   - POST (the button click — an explicit user action a scanner won't perform)
//     is the ONLY place verifyOtp runs. On success it hands off to the SAME
//     runPostAuth as /auth/callback, so post-auth behavior is identical.
//
// OAuth + legacy ?code magic links still go through /auth/callback, unchanged.

import { NextResponse } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { runPostAuth, type PostAuthParams } from "@/lib/auth/post-auth";
import { neutralizeAuthWrapper } from "@/lib/auth/redirect";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function htmlResponse(body: string, status: number): NextResponse {
  return new NextResponse(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

// The confirm page carries only these three through the GET→POST form. All
// deferred-request passthrough (action/title_id/title/request_type) and the
// final destination ride INSIDE `next` — which, after the template flip, is the
// email's {{ .RedirectTo }} = the old-style emailRedirectTo URL. The POST
// unpacks it via resolvePassthroughFromNext(). A plain `next` (e.g. /me) is used
// as the destination as-is.
const PASSTHROUGH = ["token_hash", "type", "next"] as const;

const NEST_KEYS = [
  "action",
  "title_id",
  "title",
  "request_type",
  "redirect_to",
] as const;

// neutralizeAuthWrapper (imported from @/lib/auth/redirect) collapses any auth
// entry/wrapper route (/auth/callback, /auth/confirm, /login) to /me — an auth
// route must never be a post-verify redirect destination. Shared with the
// /login signed-in bounce so the two can't drift. Enforced in EVERY branch below.

// Unpack the passthrough carried in `next`. If `next` is the old-style wrapper
// URL (e.g. /auth/callback?redirect_to=/t/x&action=request_fan_edits&title_id=…)
// — i.e. its query carries any of NEST_KEYS — extract those and use the EMBEDDED
// redirect_to as the destination; the /auth/callback wrapper itself is never a
// redirect target. Otherwise `next` is a plain path (e.g. /me) and IS the
// destination. Open-redirect safety is enforced downstream by runPostAuth's
// safeRedirect (destination must start with "/"); we also strip any host here so
// an absolute external URL collapses to a same-origin path.
function resolvePassthroughFromNext(nextRaw: string): PostAuthParams {
  const empty: PostAuthParams = {
    action: null,
    title_id: null,
    title: null,
    redirect_to: null,
    request_type: null,
  };
  if (!nextRaw) return empty;

  let u: URL;
  try {
    // Base handles root-relative values; an absolute URL ignores the base.
    u = new URL(nextRaw, "http://internal.invalid");
  } catch {
    return {
      ...empty,
      redirect_to: neutralizeAuthWrapper(
        nextRaw.startsWith("/") ? nextRaw : null,
      ),
    };
  }

  const q = u.searchParams;
  if (NEST_KEYS.some((k) => q.has(k))) {
    return {
      action: q.get("action"),
      title_id: q.get("title_id"),
      title: q.get("title"),
      request_type: q.get("request_type"),
      redirect_to: neutralizeAuthWrapper(q.get("redirect_to")),
    };
  }
  // Plain path: use its path+query as the destination (host stripped).
  return {
    ...empty,
    redirect_to: neutralizeAuthWrapper(u.pathname + u.search + u.hash),
  };
}

function page(inner: string): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in · moonbeem.</title>
</head>
<body style="margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:28px;padding:24px;background:#02133f;color:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;text-align:center;">
<div style="font-weight:700;font-size:40px;letter-spacing:-0.02em;color:#ffd4f9;">moonbeem.</div>
${inner}
</body></html>`;
}

function confirmForm(fields: Record<string, string>): string {
  const hidden = PASSTHROUGH.map(
    (k) =>
      `<input type="hidden" name="${k}" value="${escapeHtml(fields[k] ?? "")}">`,
  ).join("");
  return page(`
<p style="margin:0;font-size:16px;line-height:1.5;color:rgba(255,255,255,0.85);max-width:22rem;">Click to finish signing in to Moonbeem.</p>
<form method="POST">
  ${hidden}
  <button type="submit" style="background:#ffd4f9;color:#011754;border:0;border-radius:6px;padding:12px 24px;font-size:16px;font-weight:600;cursor:pointer;">Confirm sign-in</button>
</form>`);
}

function invalidLink(): string {
  return page(`
<p style="margin:0;font-size:16px;line-height:1.5;color:rgba(255,255,255,0.85);max-width:22rem;">This sign-in link is invalid or has expired.</p>
<a href="/login" style="background:#ffd4f9;color:#011754;text-decoration:none;border-radius:6px;padding:12px 24px;font-size:16px;font-weight:600;">Back to sign in</a>`);
}

// GET — RENDER ONLY. No verifyOtp, no token consumption, no session.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type");

  if (!tokenHash || !type) {
    return htmlResponse(invalidLink(), 400);
  }

  const fields: Record<string, string> = {};
  for (const k of PASSTHROUGH) fields[k] = searchParams.get(k) ?? "";
  return htmlResponse(confirmForm(fields), 200);
}

// POST — the ONLY place verification happens (an explicit user click).
export async function POST(request: Request) {
  const { origin } = new URL(request.url);
  const form = await request.formData();
  const tokenHash = String(form.get("token_hash") ?? "");
  const type = String(form.get("type") ?? "");

  const fail = () =>
    NextResponse.redirect(`${origin}/login?error=auth_failed`, { status: 303 });

  if (!tokenHash || !type) return fail();

  // `type` is passed to verifyOtp VERBATIM — no allowlist. This must accept
  // every email OTP type: 'magiclink' (sign-in) AND 'signup' (the new-user
  // "Confirm signup" email) AND 'recovery' etc. An invalid/unknown type simply
  // fails verifyOtp and falls through to the graceful auth_failed below.
  const supabase = await createClient();
  const { data, error } = await supabase.auth.verifyOtp({
    token_hash: tokenHash,
    type: type as EmailOtpType,
  });

  if (error || !data.user) return fail();

  // Passthrough (action/title_id/title/request_type) + the final destination are
  // unpacked from `next` (the email's {{ .RedirectTo }}). A plain `next` (e.g.
  // /me) becomes the destination as-is.
  const next = String(form.get("next") ?? "");
  return runPostAuth({
    supabase,
    userId: data.user.id,
    origin,
    userAgent: request.headers.get("user-agent"),
    params: resolvePassthroughFromNext(next),
    // POST → 303 so the browser GETs the destination (never re-POSTs).
    redirectStatus: 303,
  });
}
