// Notifies a user that content they requested for a title has been
// uploaded. Replaces the older src/lib/notifications/send-title-update-
// email.ts which mixed concerns and pre-dated the shared email scaffold.
//
// Call shape mirrors what drainQueue() already does — caller passes
// resolved email + title metadata so the queue worker doesn't re-fetch.

import type { ContentType } from "@/lib/email-queue";
import { getOrigin } from "./origin";
import { sendBrandedEmail, type SendResult } from "./send";
import {
  button,
  escapeHtml,
  paragraph,
  signoff,
  wrap,
} from "./components";

type ContentPhrasing = { noun: string; subjectNoun: string; verb: string };

function describeContent(
  type: ContentType,
  count: number,
): ContentPhrasing {
  if (type === "clip") {
    return {
      noun: count === 1 ? "clip" : "clips",
      subjectNoun: count === 1 ? "clip" : "clips",
      verb: count === 1 ? "is" : "are",
    };
  }
  if (type === "still") {
    return {
      noun: count === 1 ? "still" : "stills",
      subjectNoun: count === 1 ? "still" : "stills",
      verb: count === 1 ? "is" : "are",
    };
  }
  return {
    noun: count === 1 ? "fan edit" : "fan edits",
    subjectNoun: count === 1 ? "fan edit" : "fan edits",
    verb: count === 1 ? "is" : "are",
  };
}

function formatRequestDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

type BuildArgs = {
  contentType: ContentType;
  contentCount: number;
  titleName: string;
  titleSlug: string;
  requestedAtIso?: string | null;
  unsubscribeUrl?: string;
  origin: string;
};

export function buildRequestFulfilledEmail(args: BuildArgs): {
  subject: string;
  html: string;
  text: string;
} {
  const {
    contentType,
    contentCount,
    titleName,
    titleSlug,
    requestedAtIso,
    unsubscribeUrl,
    origin,
  } = args;
  const phrasing = describeContent(contentType, contentCount);
  const titleHref = `${origin}/t/${encodeURIComponent(titleSlug)}`;
  const titleNameEsc = escapeHtml(titleName);
  const requestedDateLabel = formatRequestDate(requestedAtIso ?? null);

  const requestedFragment = requestedDateLabel
    ? paragraph(
        `<span style="color:#5a5a5a;font-size:14px;">You requested these on ${escapeHtml(requestedDateLabel)}.</span>`,
      )
    : "";

  const innerHtml = [
    paragraph("Hey Beemer,"),
    paragraph(
      `The ${phrasing.noun} you requested for ${titleNameEsc} ${phrasing.verb} now available on Moonbeem.`,
    ),
    button({
      href: titleHref,
      label: `See the ${phrasing.noun}`,
      variant: "accent",
    }),
    requestedFragment,
    signoff(),
  ]
    .filter(Boolean)
    .join("\n");

  const html = wrap({
    innerHtml,
    origin,
    unsubscribeUrl,
    reasonLine: `You're receiving this because you requested content for ${titleNameEsc}.`,
  });

  const textLines = [
    "Hey Beemer,",
    "",
    `The ${phrasing.noun} you requested for ${titleName} ${phrasing.verb} now available on Moonbeem.`,
    "",
    `See the ${phrasing.noun}: ${titleHref}`,
  ];
  if (requestedDateLabel) {
    textLines.push("", `You requested these on ${requestedDateLabel}.`);
  }
  textLines.push("", "More soon,", "Team Moonbeem");

  return {
    subject: `The ${phrasing.subjectNoun} you requested for ${titleName} ${phrasing.verb} now available`,
    html,
    text: textLines.join("\n"),
  };
}

// Direct-send variant for callers that already have the metadata. The
// email queue is the primary caller — it batch-loads emails/titles/
// prefs once per drain, then invokes this per row.
export async function sendRequestFulfilledEmail(args: {
  to: string;
  contentType: ContentType;
  contentCount: number;
  titleName: string;
  titleSlug: string;
  requestedAtIso?: string | null;
  unsubscribeUrl?: string;
}): Promise<SendResult> {
  const { subject, html, text } = buildRequestFulfilledEmail({
    contentType: args.contentType,
    contentCount: args.contentCount,
    titleName: args.titleName,
    titleSlug: args.titleSlug,
    requestedAtIso: args.requestedAtIso ?? null,
    unsubscribeUrl: args.unsubscribeUrl,
    origin: getOrigin(),
  });

  return sendBrandedEmail({ to: args.to, subject, html, text });
}
