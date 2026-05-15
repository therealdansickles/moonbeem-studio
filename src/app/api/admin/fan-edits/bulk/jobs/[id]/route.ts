// GET /api/admin/fan-edits/bulk/jobs/[id] — polling endpoint for the
// bulk import UI. Returns the current snapshot of a job's progress
// and per-row outcomes. Super-admin only; RLS additionally restricts
// SELECT to super-admins (defense in depth).

import { NextResponse, type NextRequest } from "next/server";
import { requireSuperAdmin } from "@/lib/dal";
import { enforce } from "@/lib/ratelimit";
import { createServiceRoleClient } from "@/lib/supabase/service";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireSuperAdmin();
  const rl = await enforce(
    "admin",
    session.userId,
    "admin/fan-edits/bulk/jobs",
  );
  if (!rl.ok) return rl.response;

  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  const sb = createServiceRoleClient();
  const { data, error } = await sb
    .from("bulk_import_jobs")
    .select(
      "id, status, total_rows, processed_rows, succeeded_count, failed_count, skipped_count, rows, created_at, completed_at",
    )
    .eq("id", id)
    .maybeSingle();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true, job: data });
}
