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
import { runPostAuth } from "@/lib/auth/post-auth";

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

// The passthrough params carried from the requesting page into this confirm
// page. All rendered into hidden fields (escaped) so the POST can replay them.
const PASSTHROUGH = [
  "token_hash",
  "type",
  "next",
  "action",
  "title_id",
  "title",
  "request_type",
] as const;

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

  const supabase = await createClient();
  const { data, error } = await supabase.auth.verifyOtp({
    token_hash: tokenHash,
    type: type as EmailOtpType,
  });

  if (error || !data.user) return fail();

  const next = String(form.get("next") ?? "");
  return runPostAuth({
    supabase,
    userId: data.user.id,
    origin,
    userAgent: request.headers.get("user-agent"),
    params: {
      action: (form.get("action") as string) || null,
      title_id: (form.get("title_id") as string) || null,
      title: (form.get("title") as string) || null,
      redirect_to: next || null,
      request_type: (form.get("request_type") as string) || null,
    },
    // POST → 303 so the browser GETs the destination (never re-POSTs).
    redirectStatus: 303,
  });
}
