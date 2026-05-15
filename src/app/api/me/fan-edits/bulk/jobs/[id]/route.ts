// User-scoped polling endpoint for bulk submission jobs. Mirrors the
// admin /api/admin/fan-edits/bulk/jobs/[id] route but filters by
// user_id = session.userId so users can only poll jobs they kicked
// off. Service-role bypasses RLS (which restricts SELECT to
// super-admins); the user-scope filter is the access control here.

import { NextResponse, type NextRequest } from "next/server";
import { verifySession } from "@/lib/dal";
import { enforce } from "@/lib/ratelimit";
import { createServiceRoleClient } from "@/lib/supabase/service";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await verifySession();
  const rl = await enforce(
    "userWrites",
    session.userId,
    "me/fan-edits/bulk/jobs",
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
      "id, status, total_rows, processed_rows, succeeded_count, failed_count, skipped_count, rows, created_at, completed_at, user_id",
    )
    .eq("id", id)
    .eq("user_id", session.userId)
    .maybeSingle();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, job: data });
}
