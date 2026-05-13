// GET /api/cron/cleanup-fan-edit-events — 24-month retention sweep.
//
// Schedule: monthly at 03:00 UTC on the 1st (configured in vercel.json).
// Deletes rows from fan_edit_events older than 24 months.
//
// Retention claim in the privacy policy is "24 months from the event
// date"; monthly cadence means the actual oldest row at any moment may
// be up to ~24 months + ~30 days, well within the spirit of the claim
// and well clear of audit-defensible boundaries.
//
// Auth: same CRON_SECRET pattern as the email-queue drain cron.

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/service";

const RETENTION_MONTHS = 24;

export async function GET(request: NextRequest) {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    console.error("[cron/cleanup-fan-edit-events] CRON_SECRET env not set");
    return NextResponse.json(
      { error: "cron_secret_not_configured" },
      { status: 503 },
    );
  }

  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${expected}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  const cutoff = new Date(
    Date.now() - RETENTION_MONTHS * 30 * 24 * 60 * 60 * 1000,
  ).toISOString();

  try {
    const supabase = createServiceRoleClient();
    // PostgREST's delete().lt() returns no count by default; ask for
    // exact so the response is observable. For very large purges
    // (unlikely at our cadence) we'd batch — at monthly cadence the
    // delta is bounded to ~1 month of events.
    const { error, count } = await supabase
      .from("fan_edit_events")
      .delete({ count: "exact" })
      .lt("created_at", cutoff);
    if (error) {
      console.error(
        `[cron/cleanup-fan-edit-events] delete failed: ${error.message}`,
      );
      return NextResponse.json(
        { error: "delete_failed", message: error.message },
        { status: 500 },
      );
    }
    const elapsed_ms = Date.now() - startedAt;
    console.log(
      `[cron/cleanup-fan-edit-events] deleted=${count ?? 0} cutoff=${cutoff} elapsed_ms=${elapsed_ms}`,
    );
    return NextResponse.json({
      deleted: count ?? 0,
      cutoff,
      elapsed_ms,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[cron/cleanup-fan-edit-events] threw: ${msg}`);
    return NextResponse.json(
      { error: "cleanup_failed", message: msg },
      { status: 500 },
    );
  }
}
