// POST /api/admin/clips/[id]/delete — soft delete a clip.
//
// Sets clips.deleted_at = now(). Public RLS excludes deleted rows
// (added in 20260508000009_clips_stills_soft_delete) so the file
// drops out of /t/[slug] reads immediately. The R2 object is left
// in place — soft delete is reversible. A separate purge job (TBD)
// will hard-delete + remove R2 objects after a retention window.
//
// Idempotent: a re-click on an already-deleted clip returns
// already_deleted=true.

import { NextResponse, type NextRequest } from "next/server";
import { requireSuperAdmin } from "@/lib/dal";
import { createServiceRoleClient } from "@/lib/supabase/service";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  await requireSuperAdmin();
  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from("clips")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id)
    .is("deleted_at", null)
    .select("id, deleted_at")
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, id, already_deleted: data === null });
}
