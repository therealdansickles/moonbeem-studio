// Approve a pending fan_edit. Flips verification_status to 'approved',
// fires fulfillTitleRequestsForFanEdit (so any open title_requests
// close + their submitters get notified), and sends the
// fan_edit_approved email to the original submitter.

import { NextResponse, after, type NextRequest } from "next/server";
import { requireSuperAdmin } from "@/lib/dal";
import { enforce } from "@/lib/ratelimit";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { fulfillTitleRequestsForFanEdit } from "@/lib/title-requests/fulfill-on-fan-edit";
import { sendFanEditApproved } from "@/lib/email/fan-edit";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireSuperAdmin();
  const rl = await enforce("admin", session.userId, "admin/fan-edits/approve");
  if (!rl.ok) return rl.response;

  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  const sb = createServiceRoleClient();
  const { data: row, error: readErr } = await sb
    .from("fan_edits")
    .select("id, title_id, created_by_user_id, verification_status")
    .eq("id", id)
    .maybeSingle();
  if (readErr || !row) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (row.verification_status !== "pending") {
    return NextResponse.json(
      { error: `not pending (status=${row.verification_status})` },
      { status: 409 },
    );
  }

  const { error: updateErr } = await sb
    .from("fan_edits")
    .update({
      verification_status: "approved",
      // Audit columns added by 20260526000005. Same columns are
      // populated by the partner-decide path so all three routes
      // produce a consistent audit trail going forward.
      decided_by_user_id: session.userId,
      decided_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (updateErr) {
    return NextResponse.json({ error: updateErr.message }, { status: 500 });
  }

  // Fulfill any open fan_edits requests for this title (Block 2.6
  // already scopes this to request_type='fan_edits' only).
  try {
    await fulfillTitleRequestsForFanEdit(sb, row.title_id as string, id);
  } catch (err) {
    console.error("fulfillTitleRequestsForFanEdit failed (approve)", err);
  }

  // Email the submitter. Fail-soft; approval is the source of truth.
  if (row.created_by_user_id) {
    const userId = row.created_by_user_id as string;
    const titleId = row.title_id as string;
    after(async () => {
      try {
        const res = await sendFanEditApproved({
          userId,
          fanEditId: id,
          titleId,
        });
        if (!res.ok) console.warn("[fan_edit_approved] send failed", res.error);
      } catch (e) {
        console.warn("[fan_edit_approved] send threw", e);
      }
    });
  }

  return NextResponse.json({ ok: true });
}
