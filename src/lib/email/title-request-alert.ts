// Internal admin alert when a user requests fan edits or clips/stills
// for a title. Fire-and-forget from /api/titles/request — fails do not
// affect the user's request flow.
//
// Goes to MOONBEEM_ALERT_EMAIL (defaults to hello@moonbeem.studio).
// Not queued — single internal recipient, low volume, doesn't need
// retry resilience yet. If volume grows we move it into email_queue.

import { createServiceRoleClient } from "@/lib/supabase/service";
import { getOrigin } from "./origin";
import { sendBrandedEmail, type SendResult } from "./send";
import { escapeHtml, paragraph, signoff, wrap } from "./components";

type RequestType = "fan_edits" | "clips" | "stills";

function getAdminEmail(): string {
  return process.env.MOONBEEM_ALERT_EMAIL ?? "hello@moonbeem.studio";
}

function describeRequestType(t: RequestType): {
  short: string;
  noun: string;
} {
  if (t === "fan_edits") return { short: "fan edit", noun: "fan edits" };
  if (t === "clips") return { short: "clips", noun: "clips" };
  return { short: "stills", noun: "stills" };
}

type BuildArgs = {
  requestType: RequestType;
  titleName: string;
  titleSlug: string;
  requesterHandle: string | null;
  requesterEmail: string;
  totalRequestersForTitle: number;
  origin: string;
};

export function buildTitleRequestAlert(args: BuildArgs): {
  subject: string;
  html: string;
  text: string;
} {
  const {
    requestType,
    titleName,
    titleSlug,
    requesterHandle,
    requesterEmail,
    totalRequestersForTitle,
    origin,
  } = args;
  const { short, noun } = describeRequestType(requestType);
  const titleHref = `${origin}/t/${encodeURIComponent(titleSlug)}`;
  const adminHref = `${origin}/admin/titles/${encodeURIComponent(titleSlug)}`;
  const requesterLabel = requesterHandle
    ? `@${requesterHandle} (${requesterEmail})`
    : requesterEmail;

  const otherCount = Math.max(0, totalRequestersForTitle - 1);
  const otherFragment =
    otherCount === 0
      ? "First requester for this title."
      : otherCount === 1
        ? "1 other requester for this title."
        : `${otherCount} other requesters for this title.`;

  const innerHtml = [
    paragraph(`A user just requested ${escapeHtml(noun)} for ${escapeHtml(titleName)}.`),
    paragraph(`Requester: ${escapeHtml(requesterLabel)}`),
    paragraph(escapeHtml(otherFragment)),
    paragraph(
      `Title page: <a href="${titleHref}" style="color:#011754;">${titleHref}</a>`,
    ),
    paragraph(
      `Admin: <a href="${adminHref}" style="color:#011754;">${adminHref}</a>`,
    ),
    signoff("Auto-sent from Moonbeem."),
  ].join("\n");

  const html = wrap({ innerHtml, origin });
  const text = [
    `A user just requested ${noun} for ${titleName}.`,
    `Requester: ${requesterLabel}`,
    otherFragment,
    "",
    `Title page: ${titleHref}`,
    `Admin: ${adminHref}`,
    "",
    "Auto-sent from Moonbeem.",
  ].join("\n");

  return {
    subject: `New ${short} request for ${titleName}`,
    html,
    text,
  };
}

export async function sendTitleRequestAlert(args: {
  titleId: string;
  requesterUserId: string;
  requestType: RequestType;
}): Promise<SendResult> {
  const sb = createServiceRoleClient();
  const [titleRes, userRes, countRes] = await Promise.all([
    sb
      .from("titles")
      .select("id, title, slug")
      .eq("id", args.titleId)
      .maybeSingle(),
    sb
      .from("users")
      .select("id, email, handle")
      .eq("id", args.requesterUserId)
      .maybeSingle(),
    sb
      .from("title_requests")
      .select("user_id", { count: "exact", head: true })
      .eq("title_id", args.titleId)
      .eq("request_type", args.requestType),
  ]);

  if (titleRes.error || !titleRes.data) {
    return {
      ok: false,
      error: titleRes.error?.message ?? "title not found",
    };
  }
  if (userRes.error || !userRes.data?.email) {
    return {
      ok: false,
      error: userRes.error?.message ?? "user not found or has no email",
    };
  }

  const { subject, html, text } = buildTitleRequestAlert({
    requestType: args.requestType,
    titleName: titleRes.data.title as string,
    titleSlug: titleRes.data.slug as string,
    requesterHandle: (userRes.data.handle as string | null) ?? null,
    requesterEmail: userRes.data.email as string,
    totalRequestersForTitle: countRes.count ?? 0,
    origin: getOrigin(),
  });

  return sendBrandedEmail({
    to: getAdminEmail(),
    subject,
    html,
    text,
  });
}
