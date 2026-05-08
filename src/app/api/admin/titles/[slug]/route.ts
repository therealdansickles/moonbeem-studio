// PATCH /api/admin/titles/[slug] — toggle is_active / is_public.
//
// Super-admin only. Body shape: { is_active?: boolean, is_public?: boolean }.
// Constraint: is_public=true is rejected when the resulting is_active
// would be false (a hidden-but-public state makes no sense). The
// route enforces this against the merged state, not just the request
// payload, so toggling Public on while Active is off rejects with a
// clear error.

import { NextResponse, type NextRequest } from "next/server";
import { requireSuperAdmin } from "@/lib/dal";
import { createServiceRoleClient } from "@/lib/supabase/service";

type Body = {
  is_active?: boolean;
  is_public?: boolean;
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
    body.is_public === undefined
  ) {
    return NextResponse.json({ error: "no_fields" }, { status: 400 });
  }
  if (body.is_active !== undefined && typeof body.is_active !== "boolean") {
    return NextResponse.json({ error: "is_active_not_boolean" }, { status: 400 });
  }
  if (body.is_public !== undefined && typeof body.is_public !== "boolean") {
    return NextResponse.json({ error: "is_public_not_boolean" }, { status: 400 });
  }

  const supabase = createServiceRoleClient();
  const { data: current, error: readErr } = await supabase
    .from("titles")
    .select("id, slug, is_active, is_public, partner_id")
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

  const update: Body = {};
  if (body.is_active !== undefined) update.is_active = body.is_active;
  if (body.is_public !== undefined) update.is_public = body.is_public;
  // Cascade: if turning off Active, also turn off Public.
  if (body.is_active === false && current.is_public) {
    update.is_public = false;
  }

  const { data: updated, error: writeErr } = await supabase
    .from("titles")
    .update(update)
    .eq("id", current.id as string)
    .select("id, slug, is_active, is_public")
    .maybeSingle();
  if (writeErr) {
    return NextResponse.json({ error: writeErr.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, title: updated });
}
