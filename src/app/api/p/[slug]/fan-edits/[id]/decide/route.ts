// Partner-admin endpoint for approving or rejecting a fan_edit
// submitted to one of the partner's titles. Same approval authority
// as super-admins, scoped to fan_edits whose title.partner_id
// matches a partner_users membership for the acting user.
//
// POST /api/p/[slug]/fan-edits/[id]/decide
// Body: { decision: 'approved' | 'rejected', reason?: string }
//
// Auth (mirrors /api/p/[slug]/campaigns/route.ts):
//   - getUser → 401 if unauthenticated.
//   - enforce("partnerWrites", ...) rate limit.
//   - SELECT partner by slug → 404.
//   - super_admin bypass via getCurrentProfile.role.
//   - Otherwise: partner_users membership with role='admin' required.
//     Viewer-role gets 403.
//   - fan_edit MUST belong to a title with this partner_id. NULL or
//     mismatch → 403 (the fan_edit isn't this partner's to decide).
//
// Asymmetry vs super-admin reject (intentional, per spec):
//   - APPROVE: fires fulfillTitleRequestsForFanEdit AND sends
//     fan_edit_approved email via after(). Same behavior as the
//     super-admin path — approval is approval regardless of who
//     pressed the button.
//   - REJECT: DOES NOT send any creator email. Partner rejection is
//     not platform moderation; the creator-facing notification UX
//     for "your edit was rejected" is the super-admin path's
//     responsibility (the super-admin route REQUIRES a reason so it
//     can render it in the email). Partner rejection is an
//     editorial decision by the partner; reason is optional and
//     written for audit only, not sent to anyone.
//
// Audit: decided_by_user_id + decided_at populated in the same
// UPDATE. The super-admin approve + reject routes were updated in
// this same slice to write the audit columns too, so all three
// paths produce a consistent audit trail going forward.

import { NextResponse, after, type NextRequest } from "next/server";
import { revalidatePath } from "next/cache";
import { getCurrentProfile, getUser } from "@/lib/dal";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { enforce } from "@/lib/ratelimit";
import { fulfillTitleRequestsForFanEdit } from "@/lib/title-requests/fulfill-on-fan-edit";
import { sendFanEditApproved } from "@/lib/email/fan-edit";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REASON_MAX = 500;

type Body = { decision?: string; reason?: string };

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string; id: string }> },
) {
  const user = await getUser();
  if (!user) {
    return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  }
  const limit = await enforce(
    "partnerWrites",
    user.id,
    "p/fan-edits/decide",
  );
  if (!limit.ok) return limit.response;

  const { slug, id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  const supabase = createServiceRoleClient();

  const { data: partner } = await supabase
    .from("partners")
    .select("id")
    .eq("slug", slug)
    .maybeSingle();
  if (!partner) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // super_admin bypass; otherwise partner_users.role='admin' required.
  const profile = await getCurrentProfile();
  if (profile?.role !== "super_admin") {
    const { data: membership } = await supabase
      .from("partner_users")
      .select("role")
      .eq("partner_id", partner.id)
      .eq("user_id", user.id)
      .is("deleted_at", null)
      .maybeSingle();
    if (!membership || membership.role !== "admin") {
      return NextResponse.json({ error: "not_authorized" }, { status: 403 });
    }
  }

  // Validate body.
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const decision = body.decision;
  if (decision !== "approved" && decision !== "rejected") {
    return NextResponse.json({ error: "invalid_decision" }, { status: 400 });
  }
  // Reason is partner-internal audit only; only meaningful on reject.
  // Ignored on approve, validated on reject.
  let reason: string | null = null;
  if (decision === "rejected" && typeof body.reason === "string") {
    const r = body.reason.trim();
    if (r.length > REASON_MAX) {
      return NextResponse.json(
        { error: `reason too long (max ${REASON_MAX} chars)` },
        { status: 400 },
      );
    }
    if (r.length > 0) reason = r;
  }

  // Fetch the fan_edit AND its title's partner_id in one round trip.
  // Inner-join on titles ensures the edit's title exists; partner_id
  // check enforces partner-scoping.
  const { data: fanEdit, error: readErr } = await supabase
    .from("fan_edits")
    .select(
      "id, title_id, created_by_user_id, verification_status, titles!inner(partner_id, slug)",
    )
    .eq("id", id)
    .maybeSingle();
  if (readErr) {
    return NextResponse.json({ error: readErr.message }, { status: 500 });
  }
  if (!fanEdit) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const fanEditTitlePartnerId =
    (fanEdit.titles as unknown as { partner_id: string | null; slug: string })
      .partner_id;
  const titleSlug =
    (fanEdit.titles as unknown as { partner_id: string | null; slug: string })
      .slug;
  if (
    fanEditTitlePartnerId === null ||
    fanEditTitlePartnerId !== partner.id
  ) {
    // Edit's title belongs to a different partner (or no partner at
    // all — TMDB-imported catalog entries with NULL partner_id are
    // super-admin territory by definition). Same 403 the auth check
    // would have produced if this user weren't an admin of this
    // partner; we use a distinct error code so the client can
    // distinguish "you don't admin this partner" from "this fan_edit
    // isn't this partner's."
    return NextResponse.json(
      { error: "fan_edit_not_in_partner" },
      { status: 403 },
    );
  }

  if (fanEdit.verification_status !== "pending") {
    return NextResponse.json(
      {
        error: `not_pending`,
        current_status: fanEdit.verification_status,
      },
      { status: 409 },
    );
  }

  // Single UPDATE: status flip + audit stamp + rejection_reason if
  // reject path supplied one. rejection_reason explicitly nulled on
  // approve to avoid carrying a stale reason if the fan_edit was
  // previously rejected and somehow re-pended (defensive; the
  // pending guard above should prevent this in practice).
  const update: {
    verification_status: "approved" | "rejected";
    decided_by_user_id: string;
    decided_at: string;
    rejection_reason: string | null;
  } = {
    verification_status: decision,
    decided_by_user_id: user.id,
    decided_at: new Date().toISOString(),
    rejection_reason: decision === "rejected" ? reason : null,
  };

  const { error: updateErr, data: updated } = await supabase
    .from("fan_edits")
    .update(update)
    .eq("id", id)
    .select(
      "id, title_id, verification_status, decided_by_user_id, decided_at, rejection_reason",
    )
    .maybeSingle();
  if (updateErr || !updated) {
    return NextResponse.json(
      { error: updateErr?.message ?? "update_failed" },
      { status: 500 },
    );
  }

  const titleId = fanEdit.title_id as string;
  const createdByUserId = fanEdit.created_by_user_id as string | null;

  if (decision === "approved") {
    // Mirror the super-admin approve path: fulfill any open
    // title_requests on this title, then email the submitter.
    try {
      await fulfillTitleRequestsForFanEdit(supabase, titleId, id);
    } catch (err) {
      console.error(
        `[partner-decide] fulfillTitleRequestsForFanEdit failed for fan_edit=${id} title=${titleId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (createdByUserId) {
      after(async () => {
        try {
          const res = await sendFanEditApproved({
            userId: createdByUserId,
            fanEditId: id,
            titleId,
          });
          if (!res.ok) {
            console.warn(
              `[partner-decide] sendFanEditApproved failed for fan_edit=${id}: ${res.error}`,
            );
          }
        } catch (e) {
          console.warn(
            `[partner-decide] sendFanEditApproved threw for fan_edit=${id}: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      });
    }
  }
  // decision === "rejected" intentionally has NO creator notification.
  // Partner rejection is an editorial choice by the partner, not
  // platform moderation. The super-admin reject path DOES email the
  // creator (and requires a reason for the email body); the partner
  // path leaves the creator un-notified in v1.

  // Revalidate every surface that filters fan_edits through the
  // canonical readable gate. The flipped row drops off public reads
  // immediately (rejected) or appears on them (approved).
  revalidatePath(`/p/${slug}/dashboard`);
  if (titleSlug) {
    revalidatePath(`/t/${titleSlug}`);
  }
  // Homepage carousels (Trending / Recent / All Films) read through
  // the canonical gate too.
  revalidatePath("/");

  return NextResponse.json({
    ok: true,
    fan_edit: updated,
  });
}
