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

**Body (HTML):** the template lives at `email-templates/supabase-magic-link.html` so the paste target is unambiguous. Open that file, select all (`cmd+a`), copy, and paste into the Supabase template body field. Do NOT copy from the markdown block in this doc — markdown fence lines (` ```html ` / ` ``` `) will appear as literal text in the rendered email.

The template's only Supabase placeholder is `{{ .ConfirmationURL }}` (the magic-link URL).

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
