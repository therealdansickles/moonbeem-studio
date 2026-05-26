// Partner-team invite notification. Fires from POST
// /api/admin/partners/[id]/members when a super-admin adds a user
// (or re-adds a soft-removed user) as 'admin' or 'viewer' of a
// partner.
//
// The user already has a Moonbeem account by the time we reach
// this code path (find_auth_user_by_email guards the route), so
// this is a NOTIFICATION about the new role, not a signup
// invitation. There is no token, no acceptance step — the
// membership row is already live in partner_users when the email
// goes out.
//
// Direct send via sendBrandedEmail, matching welcome.ts and
// title-request-alert.ts. Not queued — partner invites are low
// volume and one-shot; the existing email_queue is shaped for
// title-content notifications (NOT NULL title_id + content_type
// CHECK) and cannot carry this payload. If volume ever justifies
// retry resilience for partner invites, queueing is a clean
// future migration.
//
// Fail-soft contract: the API route wraps the call in try/catch
// and logs on failure. A failed send must NOT fail the API
// response — the partner_users row is the source of truth; the
// super-admin can resend by re-adding (which lands on the
// resurrect path and re-fires this notification).

import { getOrigin } from "./origin";
import { sendBrandedEmail, type SendResult } from "./send";
import { escapeHtml, paragraph, signoff, wrap } from "./components";

export type PartnerInviteRole = "admin" | "viewer";

type BuildArgs = {
  partnerName: string;
  partnerSlug: string;
  role: PartnerInviteRole;
  origin: string;
};

function roleBlurb(
  role: PartnerInviteRole,
  partnerNameSafe: string,
): string {
  if (role === "admin") {
    return `You've been added as an admin of ${partnerNameSafe} on moonbeem. You can manage campaigns and rates from your dashboard.`;
  }
  return `You've been added as a viewer of ${partnerNameSafe} on moonbeem. You can see campaigns and analytics from your dashboard.`;
}

function roleBlurbPlain(
  role: PartnerInviteRole,
  partnerName: string,
): string {
  if (role === "admin") {
    return `You've been added as an admin of ${partnerName} on moonbeem. You can manage campaigns and rates from your dashboard.`;
  }
  return `You've been added as a viewer of ${partnerName} on moonbeem. You can see campaigns and analytics from your dashboard.`;
}

export function buildPartnerInviteEmail(args: BuildArgs): {
  subject: string;
  html: string;
  text: string;
} {
  const { partnerName, partnerSlug, role, origin } = args;
  const escapedName = escapeHtml(partnerName);
  const dashboardUrl =
    `${origin}/p/${encodeURIComponent(partnerSlug)}/dashboard`;

  const innerHtml = [
    paragraph("Hey Beemer,"),
    paragraph(roleBlurb(role, escapedName)),
    paragraph(
      `Visit your dashboard at <a href="${dashboardUrl}" style="color:#011754;">${dashboardUrl}</a> to get started.`,
    ),
    signoff(),
  ].join("\n");

  const html = wrap({
    innerHtml,
    origin,
    reasonLine:
      `You're receiving this because you were added to ${escapedName}'s partner team on Moonbeem.`,
  });

  const text = [
    "Hey Beemer,",
    "",
    roleBlurbPlain(role, partnerName),
    "",
    `Visit your dashboard at ${dashboardUrl} to get started.`,
    "",
    "More soon,",
    "Team Moonbeem",
  ].join("\n");

  return {
    subject: `You've been added to ${partnerName} on Moonbeem`,
    html,
    text,
  };
}

// Fail-soft sender used by the API route. Looks like
// sendWelcomeEmail and sendTitleRequestAlert — minimal lookup,
// dispatches via sendBrandedEmail, returns SendResult so the
// caller can route success/failure.
export async function sendPartnerInviteEmail(args: {
  to: string;
  partnerName: string;
  partnerSlug: string;
  role: PartnerInviteRole;
}): Promise<SendResult> {
  const { subject, html, text } = buildPartnerInviteEmail({
    partnerName: args.partnerName,
    partnerSlug: args.partnerSlug,
    role: args.role,
    origin: getOrigin(),
  });

  return sendBrandedEmail({
    to: args.to,
    subject,
    html,
    text,
  });
}
