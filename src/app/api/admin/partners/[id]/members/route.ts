// GET/POST /api/admin/partners/[id]/members
//
// GET — list active members for a partner (id, user_id, email,
//   role, created_at), oldest first. Backed by list_partner_members
//   RPC which joins partner_users to auth.users for the email
//   column.
// POST — invite a member by email + role. v1 only adds users who
//   already have a Moonbeem account; if find_auth_user_by_email
//   returns NULL we return 404 user_not_found and the UI shows
//   "User must sign in via Google OAuth first." Real
//   invite-with-email flow (account creation on invite) is a
//   followup.
//
// On POST, the unique(partner_id, user_id) on partner_users is
// total, not partial — re-inviting a previously soft-removed member
// updates the existing row (deleted_at=NULL + new role) rather than
// failing the insert. Active duplicate returns 409 already_member.
//
// Super-admin only for v1; partner-admin self-service surface is a
// followup.

import { NextResponse, type NextRequest } from "next/server";
import { requireSuperAdmin } from "@/lib/dal";
import { createServiceRoleClient } from "@/lib/supabase/service";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ROLES = new Set(["admin", "viewer"]);

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  await requireSuperAdmin();
  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  const supabase = createServiceRoleClient();
  const { data: partner } = await supabase
    .from("partners")
    .select("id")
    .eq("id", id)
    .maybeSingle();
  if (!partner) {
    return NextResponse.json({ error: "partner_not_found" }, { status: 404 });
  }
  const { data, error } = await supabase.rpc("list_partner_members", {
    p_partner_id: id,
  });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, members: data ?? [] });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  await requireSuperAdmin();
  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  let body: { email?: unknown; role?: unknown };
  try {
    body = (await request.json()) as { email?: unknown; role?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const email = typeof body.email === "string" ? body.email.trim() : "";
  const role = typeof body.role === "string" ? body.role : "";
  if (!email || !EMAIL_RE.test(email)) {
    return NextResponse.json({ error: "invalid_email" }, { status: 400 });
  }
  if (!ROLES.has(role)) {
    return NextResponse.json({ error: "invalid_role" }, { status: 400 });
  }

  const supabase = createServiceRoleClient();
  const { data: partner } = await supabase
    .from("partners")
    .select("id")
    .eq("id", id)
    .maybeSingle();
  if (!partner) {
    return NextResponse.json({ error: "partner_not_found" }, { status: 404 });
  }

  const { data: lookupUserId, error: lookupErr } = await supabase.rpc(
    "find_auth_user_by_email",
    { p_email: email },
  );
  if (lookupErr) {
    return NextResponse.json({ error: lookupErr.message }, { status: 500 });
  }
  const userId = lookupUserId as string | null;
  if (!userId) {
    return NextResponse.json({ error: "user_not_found" }, { status: 404 });
  }

  // Re-activate a soft-removed row in place when present; honour the
  // total unique(partner_id, user_id) by avoiding a duplicate INSERT.
  const { data: existing, error: selErr } = await supabase
    .from("partner_users")
    .select("id, deleted_at")
    .eq("partner_id", id)
    .eq("user_id", userId)
    .maybeSingle();
  if (selErr) {
    return NextResponse.json({ error: selErr.message }, { status: 500 });
  }

  if (existing && existing.deleted_at === null) {
    return NextResponse.json({ error: "already_member" }, { status: 409 });
  }

  let memberId: string;
  if (existing) {
    const { data: updated, error: updErr } = await supabase
      .from("partner_users")
      .update({ deleted_at: null, role })
      .eq("id", existing.id)
      .select("id")
      .maybeSingle();
    if (updErr || !updated) {
      return NextResponse.json(
        { error: updErr?.message ?? "update_failed" },
        { status: 500 },
      );
    }
    memberId = updated.id as string;
  } else {
    const { data: inserted, error: insErr } = await supabase
      .from("partner_users")
      .insert({ partner_id: id, user_id: userId, role })
      .select("id")
      .maybeSingle();
    if (insErr || !inserted) {
      return NextResponse.json(
        { error: insErr?.message ?? "insert_failed" },
        { status: 500 },
      );
    }
    memberId = inserted.id as string;
  }

  // Re-read via the RPC to return the member row in the same shape
  // the GET endpoint produces.
  const { data: members } = await supabase.rpc("list_partner_members", {
    p_partner_id: id,
  });
  const member = (members ?? []).find(
    (m: { id: string }) => m.id === memberId,
  );
  return NextResponse.json({ ok: true, member: member ?? null });
}
