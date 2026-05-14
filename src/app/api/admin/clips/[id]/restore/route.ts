// POST /api/admin/clips/[id]/restore — undo a soft-delete on a clip.
//
// Sets clips.deleted_at = NULL on a row that currently has a non-null
// deleted_at. Public RLS re-admits the row (deleted_at IS NULL gate
// added in 20260508000009). The R2 object was never removed, so the
// file is fully recoverable.
//
// Idempotent: a re-click on an already-active clip returns
// already_active=true.

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
  const limit = await enforce(
    "admin",
    session.userId,
    "admin/clips/[id]/restore",
  );
  if (!limit.ok) return limit.response;
  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from("clips")
    .update({ deleted_at: null })
    .eq("id", id)
    .not("deleted_at", "is", null)
    .select("id, deleted_at")
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, id, already_active: data === null });
}
