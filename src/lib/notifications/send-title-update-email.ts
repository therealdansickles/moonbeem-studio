type ContentType = "clip" | "still" | "fan_edit";

type SendArgs = {
  to: string;
  titleName: string;
  titleSlug: string;
  contentType: ContentType;
  contentCount: number;
  unsubscribeToken: string;
};

type SendResult =
  | { ok: true; resendMessageId: string }
  | { ok: false; error: string };

function getResendFrom(): string {
  const from = process.env.RESEND_FROM_EMAIL;
  if (!from) {
    throw new Error(
      "RESEND_FROM_EMAIL is not set. Set the verified Resend sender (e.g. noreply@moonbeem.studio) in .env.local.",
    );
  }
  return from;
}

function getResendKey(): string {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    throw new Error("RESEND_API_KEY is not set.");
  }
  return key;
}

function getOrigin(): string {
  return (
    process.env.NEXT_PUBLIC_SITE_URL ??
    process.env.VERCEL_URL ??
    "https://moonbeem.studio"
  ).replace(/\/$/, "");
}

function pluralize(count: number, singular: string): string {
  return count === 1 ? `1 new ${singular}` : `${count} new ${singular}s`;
}

function describeContent(
  type: ContentType,
  count: number,
): { phrase: string; nounSingular: string } {
  if (type === "clip") return { phrase: pluralize(count, "clip"), nounSingular: "clip" };
  if (type === "still") return { phrase: pluralize(count, "still"), nounSingular: "still" };
  return { phrase: pluralize(count, "fan edit"), nounSingular: "fan edit" };
}

export async function sendTitleUpdateEmail(args: SendArgs): Promise<SendResult> {
  const { to, titleName, titleSlug, contentType, contentCount, unsubscribeToken } = args;
  const from = getResendFrom();
  const apiKey = getResendKey();
  const origin = getOrigin();

  const { phrase } = describeContent(contentType, contentCount);
  const titleUrl = `${origin}/t/${encodeURIComponent(titleSlug)}`;
  const unsubUrl = `${origin}/api/unsubscribe?token=${encodeURIComponent(unsubscribeToken)}`;

  const subject = `New on Moonbeem: ${titleName} has fresh content`;

  const text = [
    `Hey,`,
    ``,
    `${titleName} just got ${phrase}.`,
    ``,
    `Take a look: ${titleUrl}`,
    ``,
    `More soon,`,
    `Moonbeem`,
    ``,
    `--`,
    `Stop these emails: ${unsubUrl}`,
  ].join("\n");

  const html = `<!doctype html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color:#121212;max-width:520px;margin:0 auto;padding:24px;">
  <p>Hey,</p>
  <p>${escapeHtml(titleName)} just got ${escapeHtml(phrase)}.</p>
  <p>Take a look:<br><a href="${titleUrl}" style="color:#011754;">${titleUrl}</a></p>
  <p>More soon,<br>Moonbeem</p>
  <hr style="border:none;border-top:1px solid #ddd;margin:32px 0 16px;">
  <p style="font-size:12px;color:#888;">
    You are receiving this because you requested fan edits for ${escapeHtml(titleName)}.
    <a href="${unsubUrl}" style="color:#888;">Stop these emails</a>.
  </p>
</body></html>`;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from, to, subject, html, text }),
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

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
