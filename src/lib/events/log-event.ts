// Gating Phase 2 — best-effort writer for the user_events ledger.
//
// Fail-soft by design: if the insert fails (DB hiccup, etc.) the
// error is logged and swallowed — event logging must never break
// the user action it's recording. user_events is best-effort
// analytics; user_action_counts is the source of truth for gating.
//
// Super-admins ARE logged (the ledger is who-did-what). Anonymous
// actions are not — there's no user_id to attach.

import { createServiceRoleClient } from "@/lib/supabase/service";

export interface UserEventInput {
  user_id: string;
  event_type: string;
  resource_type?: string;
  resource_id?: string;
  title_id?: string;
  tier_at_event?: string;
  metadata?: Record<string, unknown>;
}

export async function logUserEvent(event: UserEventInput): Promise<void> {
  try {
    const supabase = createServiceRoleClient();
    const { error } = await supabase.from("user_events").insert({
      user_id: event.user_id,
      event_type: event.event_type,
      resource_type: event.resource_type ?? null,
      resource_id: event.resource_id ?? null,
      title_id: event.title_id ?? null,
      tier_at_event: event.tier_at_event ?? null,
      metadata: event.metadata ?? {},
    });
    if (error) {
      console.error("logUserEvent insert failed:", error.message, event);
    }
  } catch (err) {
    // Swallow — a logging failure must not break the user action.
    console.error("logUserEvent threw:", err, event);
  }
}
