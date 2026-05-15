// Welcome email. Fires once per creator, on first successful magic-
// link sign-in. Deduped via users.welcome_sent_at (claimed atomically
// in the auth callback before this helper is called).

import { createServiceRoleClient } from "@/lib/supabase/service";
import { getOrigin } from "./origin";
import { sendBrandedEmail, type SendResult } from "./send";
import {
  bulletList,
  button,
  escapeHtml,
  paragraph,
  signoff,
  wrap,
} from "./components";

type BuildArgs = {
  handle?: string | null;
  origin: string;
};

export function buildWelcomeEmail(args: BuildArgs): {
  subject: string;
  html: string;
  text: string;
} {
  const { handle, origin } = args;
  // Standard branded greeting — uses 'Beemer' as the universal
  // community term. Handle stays in the args signature for callers
  // that want it later but isn't used here.
  void handle;
  const greeting = "Hey Beemer,";

  const innerHtml = [
    paragraph(greeting),
    paragraph(
      "You're in. Moonbeem is the authorized fan distribution network for media.",
    ),
    paragraph("Here's what you can do next:"),
    bulletList([
      "Build your top 12 with films and series that mean something to you",
      "Verify a social handle to unlock fan edit uploads and earnings",
      "Browse what other creators are making",
    ]),
    button({ href: `${origin}/me`, label: "Open Moonbeem" }),
    paragraph(
      'Questions? Reply to this email or reach us at <a href="mailto:hello@moonbeem.studio" style="color:#011754;">hello@moonbeem.studio</a>.',
    ),
    signoff(),
  ].join("\n");

  const html = wrap({
    innerHtml,
    origin,
    reasonLine:
      "You're receiving this because you just signed up for Moonbeem.",
  });

  const text = [
    "Hey Beemer,",
    "",
    "You're in. Moonbeem is the authorized fan distribution network for media.",
    "",
    "Here's what you can do next:",
    "- Build your top 12 with films and series that mean something to you",
    "- Verify a social handle to unlock fan edit uploads and earnings",
    "- Browse what other creators are making",
    "",
    `Open Moonbeem: ${origin}/me`,
    "",
    "Questions? Reply to this email or reach us at hello@moonbeem.studio.",
    "",
    "More soon,",
    "Team Moonbeem",
  ].join("\n");

  return {
    subject: "Welcome to Moonbeem",
    html,
    text,
  };
}

// Fail-soft helper used by the auth callback. Looks up email + handle,
// renders, dispatches. Caller already claimed the slot via
// welcome_sent_at — this only sends.
export async function sendWelcomeEmail(userId: string): Promise<SendResult> {
  const sb = createServiceRoleClient();
  const { data: user, error } = await sb
    .from("users")
    .select("id, email, handle")
    .eq("id", userId)
    .maybeSingle();
  if (error || !user?.email) {
    return {
      ok: false,
      error: error?.message ?? "user not found or has no email",
    };
  }

  const { subject, html, text } = buildWelcomeEmail({
    handle: (user.handle as string | null) ?? null,
    origin: getOrigin(),
  });

  return sendBrandedEmail({
    to: user.email as string,
    subject,
    html,
    text,
  });
}
