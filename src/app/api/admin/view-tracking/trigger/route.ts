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

export async function POST() {
  await requireSuperAdmin();
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase.functions.invoke("view-tracking", {
    body: {},
  });
  if (error) {
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true, result: data });
}
