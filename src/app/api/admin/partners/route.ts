// /api/admin/partners
//
// GET — list all partners (id, slug, name, logo_url) for the
//   partner-attribution modal's picker.
// POST — create a new partner. Body: { name, slug, logo_url? }.
//   Returns the created row. Slug must be lowercase-kebab; uniqueness
//   enforced by the partners.slug unique constraint (returns 409 on
//   conflict so the UI can surface a clear error).
//
// Super-admin only.

import { NextResponse, type NextRequest } from "next/server";
import { revalidatePath } from "next/cache";
import { requireSuperAdmin } from "@/lib/dal";
import { enforce } from "@/lib/ratelimit";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { buildPublicUrl } from "@/lib/r2/upload";
import { nextMarqueeOrder } from "@/lib/marquee-order";

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

type CreateBody = {
  name?: string;
  slug?: string;
  // Either logo_url (already a public URL — typically empty for new
  // partners) or logo_key (R2 object key from the upload flow). When
  // logo_key is set, server resolves it via buildPublicUrl. logo_key
  // wins if both are provided.
  logo_url?: string | null;
  logo_key?: string | null;
};

export async function GET() {
  const session = await requireSuperAdmin();
  const limit = await enforce("admin", session.userId, "admin/partners");
  if (!limit.ok) return limit.response;
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from("partners")
    .select("id, slug, name, logo_url")
    .order("name", { ascending: true });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ partners: data ?? [] });
}

export async function POST(request: NextRequest) {
  const session = await requireSuperAdmin();
  const limit = await enforce("admin", session.userId, "admin/partners");
  if (!limit.ok) return limit.response;
  let body: CreateBody;
  try {
    body = (await request.json()) as CreateBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const name = (body.name ?? "").trim();
  const slug = (body.slug ?? "").trim().toLowerCase();
  const logoKey = body.logo_key?.trim() || null;
  const logoUrl = logoKey
    ? buildPublicUrl(logoKey)
    : body.logo_url?.trim() || null;

  if (!name) {
    return NextResponse.json({ error: "name_required" }, { status: 400 });
  }
  if (!slug || !SLUG_RE.test(slug)) {
    return NextResponse.json({ error: "invalid_slug" }, { status: 400 });
  }

  const supabase = createServiceRoleClient();
  // Auto-append to marquee: new partners are marquee_visible=true by
  // default and land at the end. The homepage strip additionally
  // filters logo_url IS NOT NULL, so partners created without a logo
  // hold their slot but don't render until they upload one.
  const marqueeOrder = await nextMarqueeOrder(supabase);
  const { data, error } = await supabase
    .from("partners")
    .insert({
      name,
      slug,
      logo_url: logoUrl,
      is_marquee_visible: true,
      marquee_order: marqueeOrder,
    })
    .select("id, slug, name, logo_url, is_marquee_visible, marquee_order")
    .single();

  if (error) {
    if (error.code === "23505") {
      return NextResponse.json(
        { error: "slug_taken" },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (logoUrl) {
    revalidatePath("/");
  }
  return NextResponse.json({ partner: data }, { status: 201 });
}
