// Reject a pending fan_edit with a reason. Flips verification_status
// to 'rejected', stores the reason on the row, and emails the
// submitter. No title_requests fulfillment — rejection leaves any
// open requests open (they need real content, this submission
// didn't qualify).

import { NextResponse, after, type NextRequest } from "next/server";
import { requireSuperAdmin } from "@/lib/dal";
import { enforce } from "@/lib/ratelimit";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { sendFanEditRejected } from "@/lib/email/fan-edit";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REASON_MAX = 500;

type Body = { reason?: string };

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireSuperAdmin();
  const rl = await enforce("admin", session.userId, "admin/fan-edits/reject");
  if (!rl.ok) return rl.response;

  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const reason = (body.reason ?? "").trim();
  if (!reason) {
    return NextResponse.json({ error: "reason required" }, { status: 400 });
  }
  if (reason.length > REASON_MAX) {
    return NextResponse.json(
      { error: `reason too long (max ${REASON_MAX} chars)` },
      { status: 400 },
    );
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
      verification_status: "rejected",
      rejection_reason: reason,
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

  if (row.created_by_user_id) {
    const userId = row.created_by_user_id as string;
    const titleId = row.title_id as string;
    after(async () => {
      try {
        const res = await sendFanEditRejected({
          userId,
          fanEditId: id,
          titleId,
          reason,
        });
        if (!res.ok) console.warn("[fan_edit_rejected] send failed", res.error);
      } catch (e) {
        console.warn("[fan_edit_rejected] send threw", e);
      }
    });
  }

  return NextResponse.json({ ok: true });
}
