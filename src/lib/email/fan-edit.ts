// Fan edit lifecycle emails — pending review, approved, rejected.
//
// Block 3 (user upload flow) will call these on insert / approval /
// rejection. They're fail-soft so a Resend hiccup never blocks the
// parent action.
//
// Linking conventions:
//   - pending  → /me        (where the user's submission list lives)
//   - approved → /t/{slug}  (canonical surface for the edit)
//   - rejected → /c/{handle} (profile, where unattributed edits sit)
//
// All copy follows the brand-voice rules: no exclamation marks, no em
// dashes, "Hey Beemer," opener, "More soon, Team Moonbeem" sign-off.

import { createServiceRoleClient } from "@/lib/supabase/service";
import { getOrigin } from "./origin";
import { sendBrandedEmail, type SendResult } from "./send";
import {
  button,
  escapeHtml,
  paragraph,
  signoff,
  wrap,
} from "./components";

type Variant = "pending" | "approved" | "rejected";

type BuildArgs = {
  variant: Variant;
  handle?: string | null;
  titleName: string;
  titleSlug: string;
  // Only used by the rejected variant. Free-form explanation appended
  // after the standard "common reasons" line. NOT user-facing legal
  // copy — keep it short and specific.
  reason?: string | null;
  origin: string;
};

export function buildFanEditEmail(args: BuildArgs): {
  subject: string;
  html: string;
  text: string;
} {
  const { variant, handle, titleName, titleSlug, reason, origin } = args;
  // Standard branded greeting. Handle is kept for profile-link
  // resolution below but not used in the salutation.
  const greeting = "Hey Beemer,";
  const titleNameEsc = escapeHtml(titleName);
  const titleHref = `${origin}/t/${encodeURIComponent(titleSlug)}`;
  const profileHref = handle
    ? `${origin}/c/${encodeURIComponent(handle)}`
    : `${origin}/me`;
  const meHref = `${origin}/me`;

  if (variant === "pending") {
    const innerHtml = [
      paragraph(greeting),
      paragraph(
        `Your edit for ${titleNameEsc} is in our review queue. Most edits get approved within 24 hours.`,
      ),
      paragraph(
        "You'll get an email as soon as it's live, or if we need to make a different attribution call.",
      ),
      button({ href: meHref, label: "View your pending edits" }),
      signoff(),
    ].join("\n");
    const html = wrap({
      innerHtml,
      origin,
      reasonLine:
        "You're receiving this because you just submitted a fan edit on Moonbeem.",
    });
    const text = [
      "Hey Beemer,",
      "",
      `Your edit for ${titleName} is in our review queue. Most edits get approved within 24 hours.`,
      "",
      "You'll get an email as soon as it's live, or if we need to make a different attribution call.",
      "",
      `View your pending edits: ${meHref}`,
      "",
      "More soon,",
      "Team Moonbeem",
    ].join("\n");
    return {
      subject: "Your fan edit is pending review",
      html,
      text,
    };
  }

  if (variant === "approved") {
    const innerHtml = [
      paragraph(greeting),
      paragraph(
        `Your edit for ${titleNameEsc} is now live on Moonbeem with attribution to you.`,
      ),
      button({ href: titleHref, label: "See your edit" }),
      paragraph(
        "If there's an active campaign running for this title, you'll start earning from views and clicks through your profile.",
      ),
      signoff(),
    ].join("\n");
    const html = wrap({
      innerHtml,
      origin,
      reasonLine:
        "You're receiving this because a fan edit you submitted was approved.",
    });
    const text = [
      "Hey Beemer,",
      "",
      `Your edit for ${titleName} is now live on Moonbeem with attribution to you.`,
      "",
      `See your edit: ${titleHref}`,
      "",
      "If there's an active campaign running for this title, you'll start earning from views and clicks through your profile.",
      "",
      "More soon,",
      "Team Moonbeem",
    ].join("\n");
    return {
      subject: "Your fan edit is live",
      html,
      text,
    };
  }

  // rejected
  const reasonFragment = reason
    ? paragraph(`Specifically: ${escapeHtml(reason)}.`)
    : "";
  const innerHtml = [
    paragraph(greeting),
    paragraph(
      `We couldn't attribute your edit for ${titleNameEsc} to that specific title.`,
    ),
    paragraph(
      "Common reasons: the edit covers multiple films, attribution requires partner sign-off we don't have, or the connection to the title wasn't clear.",
    ),
    reasonFragment,
    paragraph(
      "Your edit appears in the Rejected submissions section on your profile. If you'd like to appeal or discuss, reply to this email.",
    ),
    button({ href: profileHref, label: "See your profile" }),
    signoff(),
  ]
    .filter(Boolean)
    .join("\n");
  const html = wrap({
    innerHtml,
    origin,
    reasonLine:
      "You're receiving this because a fan edit you submitted needs another look.",
  });
  const textLines = [
    "Hey Beemer,",
    "",
    `We couldn't attribute your edit for ${titleName} to that specific title.`,
    "",
    "Common reasons: the edit covers multiple films, attribution requires partner sign-off we don't have, or the connection to the title wasn't clear.",
  ];
  if (reason) {
    textLines.push("", `Specifically: ${reason}.`);
  }
  textLines.push(
    "",
    "Your edit appears in the Rejected submissions section on your profile. If you'd like to appeal or discuss, reply to this email.",
    "",
    `See your profile: ${profileHref}`,
    "",
    "More soon,",
    "Team Moonbeem",
  );
  return {
    subject: "About your recent fan edit submission",
    html,
    text: textLines.join("\n"),
  };
}

// Shared loader: resolves user (email, handle), title (name, slug).
async function loadContext(
  userId: string,
  titleId: string,
): Promise<
  | {
      ok: true;
      email: string;
      handle: string | null;
      titleName: string;
      titleSlug: string;
    }
  | { ok: false; error: string }
> {
  const sb = createServiceRoleClient();
  const [userRes, titleRes] = await Promise.all([
    sb.from("users").select("id, email, handle").eq("id", userId).maybeSingle(),
    sb
      .from("titles")
      .select("id, title, slug")
      .eq("id", titleId)
      .maybeSingle(),
  ]);
  if (userRes.error || !userRes.data?.email) {
    return {
      ok: false,
      error: userRes.error?.message ?? "user not found or has no email",
    };
  }
  if (titleRes.error || !titleRes.data) {
    return {
      ok: false,
      error: titleRes.error?.message ?? "title not found",
    };
  }
  return {
    ok: true,
    email: userRes.data.email as string,
    handle: (userRes.data.handle as string | null) ?? null,
    titleName: titleRes.data.title as string,
    titleSlug: titleRes.data.slug as string,
  };
}

export async function sendFanEditPending(args: {
  userId: string;
  fanEditId: string;
  titleId: string;
}): Promise<SendResult> {
  const ctx = await loadContext(args.userId, args.titleId);
  if (!ctx.ok) return ctx;
  const { subject, html, text } = buildFanEditEmail({
    variant: "pending",
    handle: ctx.handle,
    titleName: ctx.titleName,
    titleSlug: ctx.titleSlug,
    origin: getOrigin(),
  });
  return sendBrandedEmail({ to: ctx.email, subject, html, text });
}

export async function sendFanEditApproved(args: {
  userId: string;
  fanEditId: string;
  titleId: string;
}): Promise<SendResult> {
  const ctx = await loadContext(args.userId, args.titleId);
  if (!ctx.ok) return ctx;
  const { subject, html, text } = buildFanEditEmail({
    variant: "approved",
    handle: ctx.handle,
    titleName: ctx.titleName,
    titleSlug: ctx.titleSlug,
    origin: getOrigin(),
  });
  return sendBrandedEmail({ to: ctx.email, subject, html, text });
}

export async function sendFanEditRejected(args: {
  userId: string;
  fanEditId: string;
  titleId: string;
  reason?: string | null;
}): Promise<SendResult> {
  const ctx = await loadContext(args.userId, args.titleId);
  if (!ctx.ok) return ctx;
  const { subject, html, text } = buildFanEditEmail({
    variant: "rejected",
    handle: ctx.handle,
    titleName: ctx.titleName,
    titleSlug: ctx.titleSlug,
    reason: args.reason ?? null,
    origin: getOrigin(),
  });
  return sendBrandedEmail({ to: ctx.email, subject, html, text });
}
