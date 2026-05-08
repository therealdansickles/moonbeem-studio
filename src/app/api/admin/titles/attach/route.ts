// POST /api/admin/titles/attach — atomic "onboard a new partner title".
//
// Body: {
//   title_id: string,                    // required
//   partner_id?: string,                 // either set this …
//   new_partner?: { name, slug, logo_url? }, // … or this (creates partner)
//   is_active?: boolean,                 // default true
//   is_public?: boolean,                 // default false
// }
//
// Performs (in order):
//   1. If new_partner is set, INSERT partners. Returns 409 on slug
//      conflict.
//   2. UPDATE titles SET partner_id, is_active, is_public WHERE
//      id = title_id. Validates the public-requires-active invariant
//      shared with PATCH /api/admin/titles/[slug].
//   3. Returns { partner, title } so the UI can redirect to
//      /admin/titles/<title.slug>.
//
// "Atomic" in the practical sense: there's no DB transaction across
// the partner insert + title update (PostgREST doesn't expose one).
// The failure mode of a successful partner insert + a failed title
// update leaves an orphan partner row, which is harmless — the next
// retry can pick the existing partner from the dropdown.
//
// Super-admin only.

import { NextResponse, type NextRequest } from "next/server";
import { requireSuperAdmin } from "@/lib/dal";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { buildPublicUrl } from "@/lib/r2/upload";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

type NewPartner = {
  name?: string;
  slug?: string;
  logo_url?: string | null;
  logo_key?: string | null;
};
type Body = {
  title_id?: string;
  partner_id?: string | null;
  new_partner?: NewPartner;
  is_active?: boolean;
  is_public?: boolean;
};

export async function POST(request: NextRequest) {
  await requireSuperAdmin();

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  if (!body.title_id || !UUID_RE.test(body.title_id)) {
    return NextResponse.json({ error: "invalid_title_id" }, { status: 400 });
  }
  if (
    body.partner_id !== undefined &&
    body.partner_id !== null &&
    !UUID_RE.test(body.partner_id)
  ) {
    return NextResponse.json({ error: "invalid_partner_id" }, { status: 400 });
  }
  if (!body.partner_id && !body.new_partner) {
    return NextResponse.json(
      { error: "partner_id_or_new_partner_required" },
      { status: 400 },
    );
  }
  const isActive = body.is_active ?? true;
  const isPublic = body.is_public ?? false;
  if (typeof isActive !== "boolean" || typeof isPublic !== "boolean") {
    return NextResponse.json(
      { error: "is_active_or_is_public_not_boolean" },
      { status: 400 },
    );
  }
  if (isPublic && !isActive) {
    return NextResponse.json(
      { error: "public_requires_active" },
      { status: 400 },
    );
  }

  const supabase = createServiceRoleClient();

  let partnerId: string;
  let partnerRow: {
    id: string;
    slug: string;
    name: string;
    logo_url: string | null;
  };

  if (body.new_partner) {
    const name = (body.new_partner.name ?? "").trim();
    const slug = (body.new_partner.slug ?? "").trim().toLowerCase();
    const logoKey = body.new_partner.logo_key?.trim() || null;
    const logoUrl = logoKey
      ? buildPublicUrl(logoKey)
      : body.new_partner.logo_url?.trim() || null;
    if (!name) {
      return NextResponse.json({ error: "partner_name_required" }, { status: 400 });
    }
    if (!slug || !SLUG_RE.test(slug)) {
      return NextResponse.json({ error: "invalid_partner_slug" }, { status: 400 });
    }
    const { data, error } = await supabase
      .from("partners")
      .insert({ name, slug, logo_url: logoUrl })
      .select("id, slug, name, logo_url")
      .single();
    if (error) {
      if (error.code === "23505") {
        return NextResponse.json({ error: "slug_taken" }, { status: 409 });
      }
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    partnerRow = data as typeof partnerRow;
    partnerId = partnerRow.id;
  } else {
    const { data, error } = await supabase
      .from("partners")
      .select("id, slug, name, logo_url")
      .eq("id", body.partner_id as string)
      .maybeSingle();
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    if (!data) {
      return NextResponse.json({ error: "partner_not_found" }, { status: 404 });
    }
    partnerRow = data as typeof partnerRow;
    partnerId = partnerRow.id;
  }

  const { data: titleRow, error: titleErr } = await supabase
    .from("titles")
    .update({
      partner_id: partnerId,
      is_active: isActive,
      is_public: isPublic,
    })
    .eq("id", body.title_id)
    .is("deleted_at", null)
    .select("id, slug, title, year, partner_id, is_active, is_public")
    .maybeSingle();

  if (titleErr) {
    return NextResponse.json({ error: titleErr.message }, { status: 500 });
  }
  if (!titleRow) {
    return NextResponse.json({ error: "title_not_found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true, partner: partnerRow, title: titleRow });
}
