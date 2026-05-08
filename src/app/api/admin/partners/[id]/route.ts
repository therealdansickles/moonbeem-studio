// PATCH/DELETE /api/admin/partners/[id]
//
// PATCH — update name / slug / logo_url. Slug change cascades
//   visually (the /p/[slug] URL changes) but not structurally —
//   FKs reference partners.id, not the slug, so titles, rates,
//   earnings, withdrawals, partner_users all keep working. The
//   modal warns about the URL change before submit.
//
// DELETE — only allowed when no titles reference the partner.
//   Returns 409 with a clear code when titles are attached.
//   creator_earnings + partner_title_rates rows reference partner_id
//   via ON DELETE CASCADE, so they would also clear — but we don't
//   want that to be silent. Force the user to detach titles
//   explicitly first; then the partner is truly empty.
//
// Super-admin only.

import { NextResponse, type NextRequest } from "next/server";
import { requireSuperAdmin } from "@/lib/dal";
import { createServiceRoleClient } from "@/lib/supabase/service";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

type PatchBody = {
  name?: string;
  slug?: string;
  logo_url?: string | null;
};

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  await requireSuperAdmin();
  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  let body: PatchBody;
  try {
    body = (await request.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const update: Record<string, unknown> = {};
  if (body.name !== undefined) {
    const n = body.name.trim();
    if (!n) {
      return NextResponse.json({ error: "name_required" }, { status: 400 });
    }
    update.name = n;
  }
  if (body.slug !== undefined) {
    const s = body.slug.trim().toLowerCase();
    if (!s || !SLUG_RE.test(s)) {
      return NextResponse.json({ error: "invalid_slug" }, { status: 400 });
    }
    update.slug = s;
  }
  if (body.logo_url !== undefined) {
    const trimmed = body.logo_url?.trim() ?? "";
    update.logo_url = trimmed === "" ? null : trimmed;
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "no_fields" }, { status: 400 });
  }

  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from("partners")
    .update(update)
    .eq("id", id)
    .select("id, slug, name, logo_url")
    .maybeSingle();

  if (error) {
    if (error.code === "23505") {
      return NextResponse.json({ error: "slug_taken" }, { status: 409 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: "partner_not_found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, partner: data });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  await requireSuperAdmin();
  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  const supabase = createServiceRoleClient();

  // Block delete when titles are still attached — the user must
  // detach first via /admin/titles/[slug] Settings.
  const { count, error: countErr } = await supabase
    .from("titles")
    .select("id", { count: "exact", head: true })
    .eq("partner_id", id)
    .is("deleted_at", null);
  if (countErr) {
    return NextResponse.json({ error: countErr.message }, { status: 500 });
  }
  if ((count ?? 0) > 0) {
    return NextResponse.json(
      { error: "titles_attached", title_count: count },
      { status: 409 },
    );
  }

  const { error: delErr } = await supabase
    .from("partners")
    .delete()
    .eq("id", id);
  if (delErr) {
    return NextResponse.json({ error: delErr.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
