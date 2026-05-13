// POST /api/admin/fan-edits/[id]/delete — soft delete.
//
// Sets fan_edits.deleted_at = now(). The public RLS policy (added
// in 20260508000006_fan_edits_soft_delete) excludes deleted_at IS
// NOT NULL rows, so the post drops out of /t/[slug] and other
// anon/authenticated reads immediately. Service-role admin reads
// still see it (audit / restore).
//
// No-op if already deleted: idempotent re-clicks return ok=true.
// Restoring is a separate route (not built today; manual SQL for now).

import { NextResponse, type NextRequest } from "next/server";
import { requireSuperAdmin } from "@/lib/dal";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { enforce } from "@/lib/ratelimit";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireSuperAdmin();
  const limit = await enforce("admin", session.userId, "admin/fan-edits/[id]/delete");
  if (!limit.ok) return limit.response;
  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from("fan_edits")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id)
    .is("deleted_at", null)
    .select("id, deleted_at")
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // data === null when the row was already soft-deleted (no row matched
  // the deleted_at IS NULL guard). Treat as a successful no-op.
  return NextResponse.json({ ok: true, id, already_deleted: data === null });
}
