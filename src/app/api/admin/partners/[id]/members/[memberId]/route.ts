// PATCH/DELETE /api/admin/partners/[id]/members/[memberId]
//
// PATCH — change a member's role between 'admin' and 'viewer'.
//   Body: { role: 'admin'|'viewer' }.
// DELETE — soft-remove a member by setting deleted_at = now().
//   The unique(partner_id, user_id) on partner_users is total, so
//   future re-invites (POST /members) update this row in place
//   rather than insert a new one.
//
// Both gate on super_admin. Both verify (id, memberId) pair before
// mutating so a memberId from another partner can't be touched via
// this URL.

import { NextResponse, type NextRequest } from "next/server";
import { requireSuperAdmin } from "@/lib/dal";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { enforce } from "@/lib/ratelimit";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLES = new Set(["admin", "viewer"]);

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; memberId: string }> },
) {
  const session = await requireSuperAdmin();
  const limit = await enforce("admin", session.userId, "admin/partners/[id]/members/[memberId] PATCH");
  if (!limit.ok) return limit.response;
  const { id, memberId } = await params;
  if (!UUID_RE.test(id) || !UUID_RE.test(memberId)) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  let body: { role?: unknown };
  try {
    body = (await request.json()) as { role?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const role = typeof body.role === "string" ? body.role : "";
  if (!ROLES.has(role)) {
    return NextResponse.json({ error: "invalid_role" }, { status: 400 });
  }

  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from("partner_users")
    .update({ role })
    .eq("id", memberId)
    .eq("partner_id", id)
    .is("deleted_at", null)
    .select("id, role")
    .maybeSingle();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: "member_not_found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, member: data });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; memberId: string }> },
) {
  const session = await requireSuperAdmin();
  const limit = await enforce("admin", session.userId, "admin/partners/[id]/members/[memberId] DELETE");
  if (!limit.ok) return limit.response;
  const { id, memberId } = await params;
  if (!UUID_RE.test(id) || !UUID_RE.test(memberId)) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from("partner_users")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", memberId)
    .eq("partner_id", id)
    .is("deleted_at", null)
    .select("id")
    .maybeSingle();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: "member_not_found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
