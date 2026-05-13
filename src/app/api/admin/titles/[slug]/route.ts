// PATCH /api/admin/titles/[slug] — title-level admin mutations.
//
// Super-admin only. Body shape:
//   {
//     is_active?:   boolean,
//     is_public?:   boolean,
//     is_featured?: boolean,
//     partner_id?:  string | null,  // reassign or detach
//   }
//
// Invariants:
//   - is_public=true is rejected when the resulting is_active would
//     be false. Cascade: turning Active off forces Public off too.
//   - partner_id changes (reassign/detach) soft-delete the prior
//     partner's partner_title_rates row for this title. Historical
//     creator_earnings rows are immutable (left as-is). The new
//     partner needs to set their own rate from /p/[their-slug].
//   - Detaching to NULL also clears all of the title's
//     partner_title_rates (no partner means no active CPM rate).
//   - is_featured false→true assigns featured_order =
//     max(featured_order WHERE is_featured) + 1 (append to end).
//     true→false leaves featured_order untouched — the row drops out
//     of the homepage via the is_featured filter, and the stale order
//     value is inert until the row is re-featured.

import { NextResponse, type NextRequest } from "next/server";
import { revalidatePath } from "next/cache";
import { requireSuperAdmin } from "@/lib/dal";
import { createServiceRoleClient } from "@/lib/supabase/service";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Body = {
  is_active?: boolean;
  is_public?: boolean;
  is_featured?: boolean;
  partner_id?: string | null;
};

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  await requireSuperAdmin();
  const { slug } = await params;

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  if (
    body.is_active === undefined &&
    body.is_public === undefined &&
    body.is_featured === undefined &&
    body.partner_id === undefined
  ) {
    return NextResponse.json({ error: "no_fields" }, { status: 400 });
  }
  if (body.is_active !== undefined && typeof body.is_active !== "boolean") {
    return NextResponse.json({ error: "is_active_not_boolean" }, { status: 400 });
  }
  if (body.is_public !== undefined && typeof body.is_public !== "boolean") {
    return NextResponse.json({ error: "is_public_not_boolean" }, { status: 400 });
  }
  if (
    body.is_featured !== undefined &&
    typeof body.is_featured !== "boolean"
  ) {
    return NextResponse.json(
      { error: "is_featured_not_boolean" },
      { status: 400 },
    );
  }
  if (
    body.partner_id !== undefined &&
    body.partner_id !== null &&
    !UUID_RE.test(body.partner_id)
  ) {
    return NextResponse.json({ error: "invalid_partner_id" }, { status: 400 });
  }

  const supabase = createServiceRoleClient();
  const { data: current, error: readErr } = await supabase
    .from("titles")
    .select("id, slug, is_active, is_public, is_featured, partner_id, featured_order")
    .eq("slug", slug)
    .maybeSingle();
  if (readErr) {
    return NextResponse.json({ error: readErr.message }, { status: 500 });
  }
  if (!current) {
    return NextResponse.json({ error: "title_not_found" }, { status: 404 });
  }

  const nextActive = body.is_active ?? (current.is_active as boolean);
  const nextPublic = body.is_public ?? (current.is_public as boolean);

  if (nextPublic && !nextActive) {
    return NextResponse.json(
      { error: "public_requires_active" },
      { status: 400 },
    );
  }

  // If reassigning to a new partner, validate it exists.
  if (
    body.partner_id !== undefined &&
    body.partner_id !== null &&
    body.partner_id !== (current.partner_id as string | null)
  ) {
    const { data: targetPartner, error: pErr } = await supabase
      .from("partners")
      .select("id")
      .eq("id", body.partner_id)
      .maybeSingle();
    if (pErr) {
      return NextResponse.json({ error: pErr.message }, { status: 500 });
    }
    if (!targetPartner) {
      return NextResponse.json({ error: "partner_not_found" }, { status: 404 });
    }
  }

  const update: Body & { featured_order?: number } = {};
  if (body.is_active !== undefined) update.is_active = body.is_active;
  if (body.is_public !== undefined) update.is_public = body.is_public;
  if (body.partner_id !== undefined) update.partner_id = body.partner_id;
  // Cascade: if turning off Active, also turn off Public.
  if (body.is_active === false && current.is_public) {
    update.is_public = false;
  }

  // is_featured: false→true appends to end (max+1); true→false leaves
  // featured_order untouched. Same-value updates are no-ops.
  const wasFeatured = current.is_featured as boolean;
  if (body.is_featured !== undefined && body.is_featured !== wasFeatured) {
    update.is_featured = body.is_featured;
    if (body.is_featured === true) {
      const { data: maxRow } = await supabase
        .from("titles")
        .select("featured_order")
        .eq("is_featured", true)
        .order("featured_order", { ascending: false })
        .limit(1)
        .maybeSingle();
      const nextOrder = ((maxRow?.featured_order as number | null) ?? 0) + 1;
      update.featured_order = nextOrder;
    }
  }

  const { data: updated, error: writeErr } = await supabase
    .from("titles")
    .update(update)
    .eq("id", current.id as string)
    .select("id, slug, is_active, is_public, is_featured, partner_id, featured_order")
    .maybeSingle();
  if (writeErr) {
    return NextResponse.json({ error: writeErr.message }, { status: 500 });
  }

  // Featured changes affect the homepage carousel; nudge the cache.
  if (body.is_featured !== undefined && body.is_featured !== wasFeatured) {
    revalidatePath("/");
  }

  // Cascade for partner_id changes: if the prior partner was non-
  // null and either we detached (new is null) or reassigned (new is
  // a different partner), soft-delete the prior partner's rate so
  // they stop accruing earnings on a title they no longer own.
  let cleared_prior_rate = false;
  if (
    body.partner_id !== undefined &&
    current.partner_id &&
    body.partner_id !== current.partner_id
  ) {
    const { error: rateErr, count } = await supabase
      .from("partner_title_rates")
      .update({ deleted_at: new Date().toISOString() }, { count: "exact" })
      .eq("partner_id", current.partner_id as string)
      .eq("title_id", current.id as string)
      .is("deleted_at", null);
    if (rateErr) {
      // Non-fatal: title row already updated. Log and surface a
      // warning so the caller can still soft-delete via SQL.
      console.error(
        `[admin/titles/${slug}] partner_title_rates cleanup failed: ${rateErr.message}`,
      );
    }
    cleared_prior_rate = (count ?? 0) > 0;
  }

  return NextResponse.json({ ok: true, title: updated, cleared_prior_rate });
}
