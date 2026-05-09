// Helper to log an /admin Quick action invocation to admin_action_runs.
//
// Called from the action POST handlers right before they return. The
// landing page reads the latest row per action_key to render the
// "last run" timestamp + result summary on each Quick action card.

import { createServiceRoleClient } from "@/lib/supabase/service";

export type AdminActionKey = "earnings_calculate" | "view_tracking_trigger";

export type AdminActionRun = {
  id: string;
  action_key: AdminActionKey;
  triggered_by: string | null;
  triggered_at: string;
  duration_ms: number | null;
  ok: boolean;
  result: unknown;
  error_message: string | null;
};

export async function logAdminActionRun(args: {
  action_key: AdminActionKey;
  triggered_by: string | null;
  started_at: number;
  ok: boolean;
  result: unknown;
  error_message?: string | null;
}): Promise<void> {
  const supabase = createServiceRoleClient();
  const { error } = await supabase.from("admin_action_runs").insert({
    action_key: args.action_key,
    triggered_by: args.triggered_by,
    duration_ms: Date.now() - args.started_at,
    ok: args.ok,
    result: args.result ?? null,
    error_message: args.error_message ?? null,
  });
  if (error) {
    console.error(
      `[admin-action-runs] insert failed for ${args.action_key}: ${error.message}`,
    );
  }
}

export async function getLatestAdminActionRuns(
  keys: AdminActionKey[],
): Promise<Map<AdminActionKey, AdminActionRun>> {
  const out = new Map<AdminActionKey, AdminActionRun>();
  if (keys.length === 0) return out;
  const supabase = createServiceRoleClient();
  // One round trip: fetch the most recent N rows per action_key by
  // pulling the latest 50 across all keys and reducing in JS. Cheaper
  // than N parallel "limit 1" queries, and the table stays small.
  const { data } = await supabase
    .from("admin_action_runs")
    .select(
      "id, action_key, triggered_by, triggered_at, duration_ms, ok, result, error_message",
    )
    .in("action_key", keys)
    .order("triggered_at", { ascending: false })
    .limit(50);
  for (const row of data ?? []) {
    const key = row.action_key as AdminActionKey;
    if (!out.has(key)) {
      out.set(key, row as AdminActionRun);
    }
  }
  return out;
}
