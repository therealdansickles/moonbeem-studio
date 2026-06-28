// POST /api/admin/titles — manually CREATE a non-TMDB title (film/series).
//
// The catalog-sync Edge Function is the only OTHER path that inserts a
// titles row; it covers the ~1.4M TMDB catalog. This endpoint is the
// manual create-path for titles that aren't in TMDB (a non-TMDB film,
// or a series), so a partner can run a campaign on them.
//
// Body: {
//   title: string,                       // required
//   media_type: 'movie' | 'tv',          // required — REJECTS anything
//                                         //   else (the tier-3 guard:
//                                         //   non-film can't be created
//                                         //   until its rendering exists)
//   year?: number,                       // optional
//   poster_url?: string,                 // optional (external URL, v1)
//   synopsis?: string,                   // optional
//   director?: string,                   // optional
//   runtime_min?: number,                // optional
//   slug?: string,                       // optional manual override;
//                                         //   else auto-generated from
//                                         //   title (+ year)
//   partner_id?: string,                 // either this …
//   new_partner?: { name, slug, logo_url?, logo_key? }, // … or this
//   is_active?: boolean,                 // default true
//   is_public?: boolean,                 // default true (created to launch)
//   is_featured?: boolean,               // default false
// }
//
// Mirrors POST /api/admin/titles/attach for auth + partner resolution,
// but INSERTs a titles row instead of UPDATEing an existing one. Sets
// created_by = the authenticated admin and tmdb_id = null (these are
// non-TMDB rows; the partial unique (tmdb_id, media_type) index does not
// touch null-tmdb rows). Super-admin only. No schema change.

import { NextResponse, type NextRequest } from "next/server";
import { revalidatePath } from "next/cache";
import { requireSuperAdmin } from "@/lib/dal";
import { enforce } from "@/lib/ratelimit";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { buildPublicUrl } from "@/lib/r2/upload";
import { baseTitleSlug, resolveUniqueSlug } from "@/lib/titles/slug";
import { nextFeaturedOrder } from "@/lib/featured-order";
import { nextMarqueeOrder } from "@/lib/marquee-order";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ALLOWED_MEDIA_TYPES = ["movie", "tv"] as const;
// Hosting axis (titles_content_kind_check). 'film' = DRM/Mux-hosted; 'embed' =
// Instagram/social-hosted. Defaults to 'film'. Orthogonal to media_type.
const ALLOWED_CONTENT_KINDS = ["film", "embed"] as const;

type NewPartner = {
  name?: string;
  slug?: string;
  logo_url?: string | null;
  logo_key?: string | null;
};
type Body = {
  title?: string;
  media_type?: string;
  content_kind?: string;
  year?: number | null;
  poster_url?: string | null;
  synopsis?: string | null;
  director?: string | null;
  runtime_min?: number | null;
  slug?: string;
  partner_id?: string | null;
  new_partner?: NewPartner;
  is_active?: boolean;
  is_public?: boolean;
  is_featured?: boolean;
};

export async function POST(request: NextRequest) {
  const session = await requireSuperAdmin();
  const limit = await enforce("admin", session.userId, "admin/titles/create");
  if (!limit.ok) return limit.response;

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  // --- title ---
  const title = (body.title ?? "").trim();
  if (!title) {
    return NextResponse.json({ error: "title_required" }, { status: 400 });
  }

  // --- media_type (the tier-3 guard) ---
  const mediaType = body.media_type;
  if (
    typeof mediaType !== "string" ||
    !(ALLOWED_MEDIA_TYPES as readonly string[]).includes(mediaType)
  ) {
    return NextResponse.json(
      { error: "invalid_media_type", allowed: ALLOWED_MEDIA_TYPES },
      { status: 400 },
    );
  }

  // --- content_kind (hosting axis; defaults to 'film') ---
  const contentKind = body.content_kind ?? "film";
  if (!(ALLOWED_CONTENT_KINDS as readonly string[]).includes(contentKind)) {
    return NextResponse.json(
      { error: "invalid_content_kind", allowed: ALLOWED_CONTENT_KINDS },
      { status: 400 },
    );
  }

  // --- optional scalars ---
  let year: number | null = null;
  if (body.year !== undefined && body.year !== null) {
    if (
      typeof body.year !== "number" ||
      !Number.isInteger(body.year) ||
      body.year < 1870 ||
      body.year > 2100
    ) {
      return NextResponse.json({ error: "invalid_year" }, { status: 400 });
    }
    year = body.year;
  }
  let runtimeMin: number | null = null;
  if (body.runtime_min !== undefined && body.runtime_min !== null) {
    if (
      typeof body.runtime_min !== "number" ||
      !Number.isInteger(body.runtime_min) ||
      body.runtime_min < 0
    ) {
      return NextResponse.json({ error: "invalid_runtime" }, { status: 400 });
    }
    runtimeMin = body.runtime_min;
  }
  const posterUrl = body.poster_url?.trim() || null;
  const synopsis = body.synopsis?.trim() || null;
  const director = body.director?.trim() || null;

  // --- partner presence ---
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

  // --- flags (manual titles are created to launch: public/active default true) ---
  const isActive = body.is_active ?? true;
  const isPublic = body.is_public ?? true;
  const isFeatured = body.is_featured ?? false;
  if (
    typeof isActive !== "boolean" ||
    typeof isPublic !== "boolean" ||
    typeof isFeatured !== "boolean"
  ) {
    return NextResponse.json({ error: "flag_not_boolean" }, { status: 400 });
  }
  if (isPublic && !isActive) {
    return NextResponse.json(
      { error: "public_requires_active" },
      { status: 400 },
    );
  }

  const supabase = createServiceRoleClient();

  // --- partner resolution (same logic as /api/admin/titles/attach) ---
  let partnerId: string;
  let partnerRow: { id: string; slug: string; name: string; logo_url: string | null };

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
      .select("id, slug, name, logo_url")
      .single();
    if (error) {
      if (error.code === "23505") {
        return NextResponse.json({ error: "partner_slug_taken" }, { status: 409 });
      }
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    partnerRow = data as typeof partnerRow;
    partnerId = partnerRow.id;
    if (logoUrl) revalidatePath("/");
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

  // --- slug: explicit override (validate + 409 on conflict) OR auto-generate (auto-disambiguate) ---
  let slug: string;
  if (body.slug !== undefined && body.slug.trim() !== "") {
    const override = body.slug.trim().toLowerCase();
    if (!SLUG_RE.test(override)) {
      return NextResponse.json({ error: "invalid_slug" }, { status: 400 });
    }
    const { data: clash, error: clashErr } = await supabase
      .from("titles")
      .select("id")
      .eq("slug", override)
      .maybeSingle();
    if (clashErr) {
      return NextResponse.json({ error: clashErr.message }, { status: 500 });
    }
    if (clash) {
      return NextResponse.json({ error: "slug_taken" }, { status: 409 });
    }
    slug = override;
  } else {
    try {
      slug = await resolveUniqueSlug(supabase, baseTitleSlug(title, year));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const status = msg === "slug_unresolvable" ? 409 : 500;
      return NextResponse.json({ error: msg }, { status });
    }
  }

  // --- insert the title ---
  const titleInsert: Record<string, unknown> = {
    slug,
    title,
    media_type: mediaType,
    content_kind: contentKind,
    year,
    poster_url: posterUrl,
    synopsis,
    director,
    runtime_min: runtimeMin,
    partner_id: partnerId,
    is_active: isActive,
    is_public: isPublic,
    is_featured: isFeatured,
    created_by: session.userId,
    tmdb_id: null,
  };
  if (isFeatured) {
    titleInsert.featured_order = await nextFeaturedOrder(supabase);
  }

  const { data: titleRow, error: titleErr } = await supabase
    .from("titles")
    .insert(titleInsert)
    .select(
      "id, slug, title, year, media_type, partner_id, is_active, is_public, is_featured",
    )
    .single();

  if (titleErr) {
    // 23505 = unique violation (slug raced between our check and insert).
    if (titleErr.code === "23505") {
      return NextResponse.json({ error: "slug_taken" }, { status: 409 });
    }
    return NextResponse.json({ error: titleErr.message }, { status: 500 });
  }

  if (isPublic || isFeatured) revalidatePath("/");

  return NextResponse.json({ ok: true, partner: partnerRow, title: titleRow });
}
