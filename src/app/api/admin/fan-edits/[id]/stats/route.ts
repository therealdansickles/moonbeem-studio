// Admin-only aggregate stats for a single fan_edit.
//
// Stub endpoint — returns counts + average duration. The UI surface
// (/admin/fan-edits/[id]) is deferred to a later session per the
// Stage B3 spec. Once the UI exists, this endpoint feeds it.

import { NextResponse, type NextRequest } from "next/server";
import { requireSuperAdmin } from "@/lib/dal";
import { createServiceRoleClient } from "@/lib/supabase/service";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  await requireSuperAdmin();
  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from("fan_edit_events")
    .select("event_type, duration_ms, user_id")
    .eq("fan_edit_id", id);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  let openCount = 0;
  let closeCount = 0;
  let clickCount = 0;
  let durationTotal = 0;
  let durationSamples = 0;
  const signedInUsers = new Set<string>();

  for (const row of data ?? []) {
    const ev = row.event_type as string;
    if (ev === "modal_open") openCount += 1;
    else if (ev === "modal_close") {
      closeCount += 1;
      if (typeof row.duration_ms === "number") {
        durationTotal += row.duration_ms;
        durationSamples += 1;
      }
    } else if (ev === "view_on_platform_click") {
      clickCount += 1;
    }
    if (row.user_id) signedInUsers.add(row.user_id as string);
  }

  return NextResponse.json({
    fan_edit_id: id,
    open_count: openCount,
    close_count: closeCount,
    click_count: clickCount,
    avg_duration_ms: durationSamples > 0
      ? Math.round(durationTotal / durationSamples)
      : null,
    unique_signed_in_users: signedInUsers.size,
  });
}
