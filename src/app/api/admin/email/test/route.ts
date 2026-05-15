// Super-admin gated email preview / smoke-test endpoint.
//
// GET /api/admin/email/test?type=<type>&to=<email>
//
// Renders the requested template against fixed sample data and ships
// it via Resend so you can inspect the live render in your inbox.
// No DB writes — pure template-rendering path.
//
// Types: welcome, fan_edit_pending, fan_edit_approved,
//        fan_edit_rejected, title_request_alert

import { NextResponse, type NextRequest } from "next/server";
import { requireSuperAdmin } from "@/lib/dal";
import { enforce } from "@/lib/ratelimit";
import { getOrigin } from "@/lib/email/origin";
import { sendBrandedEmail } from "@/lib/email/send";
import { buildWelcomeEmail } from "@/lib/email/welcome";
import { buildFanEditEmail } from "@/lib/email/fan-edit";
import { buildTitleRequestAlert } from "@/lib/email/title-request-alert";
import { buildRequestFulfilledEmail } from "@/lib/email/request-fulfilled";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VALID_TYPES = [
  "welcome",
  "fan_edit_pending",
  "fan_edit_approved",
  "fan_edit_rejected",
  "title_request_alert",
  "request_fulfilled",
] as const;
type TestType = (typeof VALID_TYPES)[number];

export async function GET(request: NextRequest) {
  const session = await requireSuperAdmin();
  const limit = await enforce("admin", session.userId, "admin/email/test");
  if (!limit.ok) return limit.response;

  const url = new URL(request.url);
  const type = url.searchParams.get("type") ?? "";
  const to = url.searchParams.get("to") ?? "";

  if (!VALID_TYPES.includes(type as TestType)) {
    return NextResponse.json(
      {
        error: "invalid type",
        valid: VALID_TYPES,
      },
      { status: 400 },
    );
  }
  if (!EMAIL_RE.test(to)) {
    return NextResponse.json({ error: "invalid to" }, { status: 400 });
  }

  const origin = getOrigin();
  // Sample data — kept deliberately generic so the preview shows the
  // template structure, not real user/title state.
  const sample = {
    handle: "sample_handle",
    titleName: "Sample Title (1999)",
    titleSlug: "sample-title-1999",
  };

  let rendered: { subject: string; html: string; text: string };
  switch (type as TestType) {
    case "welcome":
      rendered = buildWelcomeEmail({ handle: sample.handle, origin });
      break;
    case "fan_edit_pending":
      rendered = buildFanEditEmail({
        variant: "pending",
        handle: sample.handle,
        titleName: sample.titleName,
        titleSlug: sample.titleSlug,
        origin,
      });
      break;
    case "fan_edit_approved":
      rendered = buildFanEditEmail({
        variant: "approved",
        handle: sample.handle,
        titleName: sample.titleName,
        titleSlug: sample.titleSlug,
        origin,
      });
      break;
    case "fan_edit_rejected":
      rendered = buildFanEditEmail({
        variant: "rejected",
        handle: sample.handle,
        titleName: sample.titleName,
        titleSlug: sample.titleSlug,
        reason: "the connection to the title wasn't clear",
        origin,
      });
      break;
    case "title_request_alert":
      rendered = buildTitleRequestAlert({
        requestType: "fan_edits",
        titleName: sample.titleName,
        titleSlug: sample.titleSlug,
        requesterHandle: sample.handle,
        requesterEmail: "requester@example.com",
        totalRequestersForTitle: 3,
        origin,
      });
      break;
    case "request_fulfilled":
      rendered = buildRequestFulfilledEmail({
        contentType: "clip",
        contentCount: 3,
        titleName: sample.titleName,
        titleSlug: sample.titleSlug,
        // Sample date so the "you requested these on…" line renders
        requestedAtIso: new Date(Date.now() - 7 * 86_400_000).toISOString(),
        origin,
      });
      break;
  }

  // No subject prefix — production-identical so inbox triage isn't
  // confused by mode-marker text leaking into the real Subject line.
  // The route is gated to super-admins, which is the actual "this is
  // a test" boundary.
  const result = await sendBrandedEmail({
    to,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 502 });
  }

  return NextResponse.json({
    sent: true,
    type,
    to,
    resend_message_id: result.resendMessageId,
  });
}
