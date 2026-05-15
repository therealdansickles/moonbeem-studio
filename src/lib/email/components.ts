// HTML primitives for branded transactional emails.
//
// Email clients are hostile to CSS — no variables, partial flexbox,
// Outlook strips <style> blocks. All styling is inline on each
// element. Hex colors mirror src/app/globals.css brand tokens.
//
// Layout is a single 540px column, centered, white background, dark
// text — the same dark-text-on-light-bg pattern as the existing
// send-title-update-email.ts. Hot pink violet are reserved for CTAs.

const COLORS = {
  bg: "#ffffff",
  ink: "#121212",
  inkMuted: "#5a5a5a",
  inkSubtle: "#8a8a8a",
  border: "#e6e6e6",
  navy: "#011754",
  violet: "#7c3aed",
  magenta: "#ff3da5",
} as const;

const FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif';

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Wrap inner HTML in the standard branded shell (header + footer).
// All callers should pass already-escaped/sanitized content for the
// body — this function only assembles structure.
export type WrapArgs = {
  innerHtml: string;
  origin: string;
  // When omitted, the footer hides the unsubscribe line entirely.
  // Pass the full URL when applicable (welcome email is service-tier
  // and has no unsubscribe; lifecycle emails about a user's own
  // submissions also have no unsubscribe — those are transactional).
  unsubscribeUrl?: string;
  // Bottom-of-footer line. Defaults to the standard "You're receiving
  // this because…" line for transactional emails.
  reasonLine?: string;
};

export function wrap(args: WrapArgs): string {
  const { innerHtml, origin, unsubscribeUrl, reasonLine } = args;
  const wordmarkUrl = `${origin}/`;

  const unsubFragment = unsubscribeUrl
    ? `<a href="${unsubscribeUrl}" style="color:${COLORS.inkSubtle};text-decoration:underline;">Stop these emails</a>`
    : "";

  const reasonFragment = reasonLine
    ? `<p style="font-size:12px;line-height:1.6;color:${COLORS.inkSubtle};margin:0 0 6px;">${reasonLine}</p>`
    : "";

  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Moonbeem</title></head>
<body style="margin:0;padding:0;background:${COLORS.bg};font-family:${FONT_STACK};color:${COLORS.ink};-webkit-font-smoothing:antialiased;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${COLORS.bg};">
    <tr><td align="center" style="padding:32px 16px;">
      <table role="presentation" width="540" cellpadding="0" cellspacing="0" border="0" style="max-width:540px;width:100%;">
        <tr><td style="padding:0 0 24px;">
          <a href="${wordmarkUrl}" style="text-decoration:none;color:${COLORS.ink};font-weight:700;letter-spacing:-0.01em;font-size:20px;">Moonbeem</a>
        </td></tr>
        <tr><td style="font-size:16px;line-height:1.6;color:${COLORS.ink};">
${innerHtml}
        </td></tr>
        <tr><td style="border-top:1px solid ${COLORS.border};padding:24px 0 0;margin-top:32px;">
          ${reasonFragment}
          <p style="font-size:12px;line-height:1.6;color:${COLORS.inkSubtle};margin:0;">
            <a href="${origin}/privacy-policy" style="color:${COLORS.inkSubtle};">Privacy</a>
            &middot;
            <a href="${origin}/terms-of-service" style="color:${COLORS.inkSubtle};">Terms</a>
            ${unsubFragment ? `&middot; ${unsubFragment}` : ""}
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

export function button(args: {
  href: string;
  label: string;
  variant?: "primary" | "secondary";
}): string {
  const { href, label } = args;
  const bg = args.variant === "secondary" ? COLORS.navy : COLORS.violet;
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0;"><tr><td style="border-radius:8px;background:${bg};">
    <a href="${href}" style="display:inline-block;padding:12px 22px;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;border-radius:8px;">${label}</a>
  </td></tr></table>`;
}

export function paragraph(html: string): string {
  return `<p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:${COLORS.ink};">${html}</p>`;
}

export function bulletList(items: string[]): string {
  const li = items
    .map(
      (item) =>
        `<li style="margin:0 0 8px;font-size:16px;line-height:1.6;color:${COLORS.ink};">${item}</li>`,
    )
    .join("");
  return `<ul style="margin:0 0 16px;padding:0 0 0 20px;color:${COLORS.ink};">${li}</ul>`;
}

export function signoff(line: string = "More soon,"): string {
  return paragraph(`${escapeHtml(line)}<br>The Moonbeem team`);
}
