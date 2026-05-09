// Manual invoke for the view-tracking Edge Function.
//
// Cron schedules the function on a normal cadence; this endpoint
// exists so super-admins can force a refresh from the /admin
// dashboard between cron ticks. The Edge Function itself is
// idempotent (same-UTC-day short-circuit) so manual triggers are
// safe to spam — they will return immediately if there's nothing
// eligible.

import { NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/dal";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { logAdminActionRun } from "@/lib/admin-action-runs";

export async function POST() {
  const session = await requireSuperAdmin();
  const startedAt = Date.now();
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase.functions.invoke("view-tracking", {
    body: {},
  });
  if (error) {
    await logAdminActionRun({
      action_key: "view_tracking_trigger",
      triggered_by: session.userId,
      started_at: startedAt,
      ok: false,
      result: null,
      error_message: error.message,
    });
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500 },
    );
  }
  const payload = { ok: true, result: data };
  await logAdminActionRun({
    action_key: "view_tracking_trigger",
    triggered_by: session.userId,
    started_at: startedAt,
    ok: true,
    result: payload,
  });
  return NextResponse.json(payload);
}
