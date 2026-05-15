// Branded transactional email send wrapper.
//
// Calls Resend HTTP API directly (no SDK). Returns SendResult so
// callers can route success/failure. Read RESEND_API_KEY +
// RESEND_FROM_EMAIL at call time so config changes pick up without
// redeploy churn on dev. Shared by every helper in src/lib/email/.

export type SendResult =
  | { ok: true; resendMessageId: string }
  | { ok: false; error: string };

function getResendFrom(): string {
  const from = process.env.RESEND_FROM_EMAIL;
  if (!from) {
    throw new Error(
      "RESEND_FROM_EMAIL is not set. Set the verified Resend sender (e.g. hello@moonbeem.studio) in .env.local.",
    );
  }
  // If the env value already carries a display name ('Name <email>'),
  // respect it. Otherwise wrap with 'Moonbeem' so inboxes render the
  // brand instead of the local-part. Resend's API accepts either form
  // in the From header.
  if (from.includes("<")) return from;
  return `Moonbeem <${from}>`;
}

function getResendKey(): string {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    throw new Error("RESEND_API_KEY is not set.");
  }
  return key;
}

export type SendBrandedEmailArgs = {
  to: string;
  subject: string;
  html: string;
  text: string;
  // Override the From header (defaults to RESEND_FROM_EMAIL). Useful
  // for admin-alert sends from a distinct address.
  from?: string;
};

export async function sendBrandedEmail(
  args: SendBrandedEmailArgs,
): Promise<SendResult> {
  const from = args.from ?? getResendFrom();
  const apiKey = getResendKey();

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: args.to,
      subject: args.subject,
      html: args.html,
      text: args.text,
    }),
  });

  if (!res.ok) {
    let errText = `resend ${res.status}`;
    try {
      const body = await res.text();
      errText = `resend ${res.status}: ${body.slice(0, 300)}`;
    } catch {
      // ignore
    }
    return { ok: false, error: errText };
  }

  const json = (await res.json()) as { id?: string };
  if (!json.id) {
    return { ok: false, error: "resend response missing id" };
  }
  return { ok: true, resendMessageId: json.id };
}
