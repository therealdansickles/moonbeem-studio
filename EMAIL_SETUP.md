# Email setup — Supabase SMTP + magic link template

One-time dashboard config that can't be checked into the repo. Do this on the production Supabase project (`qdngcwhubzomwymhaiel`).

## 1. SMTP — route Supabase Auth emails through Resend

Dashboard: **Project → Authentication → Emails → SMTP Settings**.

Toggle **Enable Custom SMTP** on, then enter:

| Field | Value |
|---|---|
| Host | `smtp.resend.com` |
| Port | `465` |
| Username | `resend` |
| Password | `<the value of RESEND_API_KEY>` (paste from `.env.local`) |
| Sender email | `hello@moonbeem.studio` |
| Sender name | `Moonbeem` |
| Minimum interval | `1` (seconds; default is fine) |

Click **Save**. Supabase will not send a verification email — the next real auth event (e.g. magic-link request) is the smoke test.

> Resend domain status (verified at the dashboard's Domains tab): `moonbeem.studio` is Verified. `moonbeem.xyz` is also Verified but unused — it stays in Resend as a future option (e.g. if we ever want a brand-separated transactional domain).

## 2. Magic link template

Dashboard: **Project → Authentication → Emails → Templates → Magic Link**.

**Subject:**

```
Sign in to Moonbeem
```

**Body (HTML):** paste the full block below. The `{{ .ConfirmationURL }}` placeholder is Supabase's; everything else is plain HTML.

```html
<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Moonbeem</title></head>
<body style="margin:0;padding:0;background:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#121212;-webkit-font-smoothing:antialiased;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;">
    <tr><td align="center" style="padding:32px 16px;">
      <table role="presentation" width="540" cellpadding="0" cellspacing="0" border="0" style="max-width:540px;width:100%;">
        <tr><td style="padding:0 0 24px;">
          <a href="https://moonbeem.studio/" style="text-decoration:none;color:#121212;font-weight:700;letter-spacing:-0.01em;font-size:20px;">Moonbeem</a>
        </td></tr>
        <tr><td style="font-size:16px;line-height:1.6;color:#121212;">
          <p style="margin:0 0 16px;">Hey,</p>
          <p style="margin:0 0 16px;">Click the button below to sign in to Moonbeem. The link expires in 60 minutes.</p>
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0;"><tr><td style="border-radius:8px;background:#7c3aed;">
            <a href="{{ .ConfirmationURL }}" style="display:inline-block;padding:12px 22px;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;border-radius:8px;">Sign in to Moonbeem</a>
          </td></tr></table>
          <p style="margin:0 0 16px;">If you didn't request this, you can ignore this email.</p>
          <p style="margin:0 0 16px;">More soon,<br>The Moonbeem team</p>
        </td></tr>
        <tr><td style="border-top:1px solid #e6e6e6;padding:24px 0 0;">
          <p style="font-size:12px;line-height:1.6;color:#8a8a8a;margin:0;">
            <a href="https://moonbeem.studio/privacy-policy" style="color:#8a8a8a;">Privacy</a>
            &middot;
            <a href="https://moonbeem.studio/terms-of-service" style="color:#8a8a8a;">Terms</a>
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>
```

Click **Save**.

## 3. Smoke test

1. Sign out of moonbeem.studio.
2. Hit `/login`, request a magic link to a real inbox you control.
3. Confirm:
   - From: `Moonbeem <hello@moonbeem.studio>` (NOT `noreply@mail.app.supabase.io`).
   - Branded template renders with the Moonbeem wordmark and violet CTA.
   - The CTA link works and signs you in.
4. Inbox classification: lands in primary inbox, not spam (Gmail and Apple Mail both).

## 4. Other transactional templates

The lifecycle emails (welcome, fan edit pending/approved/rejected, request alert) are sent from app code via `src/lib/email/*`, NOT from Supabase Auth. They don't need template configuration in the dashboard — they're already complete in the repo.

Smoke-test them via `/api/admin/email/test?type=<type>&to=<your-email>`. Valid types: `welcome`, `fan_edit_pending`, `fan_edit_approved`, `fan_edit_rejected`, `title_request_alert`. Super-admin gated, sends a `[test] ` prefixed copy to your address with sample data.

## 5. DNS / Resend domain ownership

Both `moonbeem.studio` and `moonbeem.xyz` are Verified in Resend (us-east-1, North Virginia). DNS records for SPF, DKIM, and DMARC are managed at the registrar — if a future "Failed" status appears in the Resend Domains tab, re-check the records there.
