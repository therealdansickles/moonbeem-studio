// POST /api/p/[slug]/titles — a partner-admin creates a NEW title under THEIR
// OWN partner (the first step of the film-upload flow: create → upload → publish).
//
// SECURITY — the whole point of this route (mirrors the /api/p/[slug]/clips rail):
//   * The new title's partner_id is the partner resolved from the [slug] PATH and
//     VERIFIED by a live partner_users admin membership. It is NEVER read from the
//     request body — any partner_id in the body is silently ignored, so a partner
//     can only ever create titles under a partner they actually admin.
//   * partner_users is UNIQUE(partner_id, user_id), so a user CAN be an admin of
//     multiple partners; we verify membership for EXACTLY the path partner, which
//     makes "which partner owns this title" unambiguous and un-forgeable.
//   * Non-members get 404 (not 403) so the route never confirms a partner's
//     existence to a non-admin — matching the /p/[slug]/dashboard page-level gate.
//   * A new title lands NOT publicly live (is_public=false): is_active/is_public/
//     is_featured are server-controlled here, never body-settable, so a partner
//     cannot self-publish a title before it has a published asset + review.
//   * Pricing/monetization/territory fields are NOT accepted — those are later
//     units; the body is limited to safe descriptive fields.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentProfile, getUser } from "@/lib/dal";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { enforce } from "@/lib/ratelimit";
import { baseTitleSlug, resolveUniqueSlug } from "@/lib/titles/slug";

// Full media_type CHECK set (titles_media_type_check). 'movie' covers feature
// AND short films; 'tv' = series; 'event' = a one-off event title (its
// date/venue are set later via the metadata editor).
const ALLOWED_MEDIA_TYPES = ["movie", "tv", "event"] as const;
const TITLE_MAX_LENGTH = 200;

type Body = {
  title?: string;
  media_type?: string;
  year?: number | null;
  synopsis?: string | null;
  runtime_min?: number | null;
  // NOTE: partner_id / slug / is_public / pricing / territory are deliberately
  // NOT part of this type — they are server-controlled, never client-supplied.
};

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  // --- Auth chain (verbatim shape from /api/p/[slug]/clips) ---
  const user = await getUser();
  if (!user) {
    return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  }
  const limit = await enforce("partnerWrites", user.id, "p/titles");
  if (!limit.ok) return limit.response;
  const { slug } = await params;
  const supabase = createServiceRoleClient();

  // Resolve the partner from the PATH slug. The new title's partner_id WILL be
  // this partner's id (set below) — never anything from the body.
  const { data: partner } = await supabase
    .from("partners")
    .select("id")
    .eq("slug", slug)
    .maybeSingle();
  if (!partner) {
    // 404 hides the partner's existence from non-members (page-level gate parity).
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // super_admin bypasses the membership check (still scoped to the slug's
  // partner); otherwise the caller must be a live partner_users admin for THIS
  // partner. Non-members get 404, not 403, so we never leak existence.
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
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
  }

  // --- Body: ONLY safe descriptive fields. Any partner_id is ignored. ---
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const title = (body.title ?? "").trim();
  if (!title) {
    return NextResponse.json({ error: "title_required" }, { status: 400 });
  }
  if (title.length > TITLE_MAX_LENGTH) {
    return NextResponse.json({ error: "title_too_long" }, { status: 400 });
  }

  const mediaType = body.media_type ?? "movie";
  if (!(ALLOWED_MEDIA_TYPES as readonly string[]).includes(mediaType)) {
    return NextResponse.json(
      { error: "invalid_media_type", allowed: ALLOWED_MEDIA_TYPES },
      { status: 400 },
    );
  }

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
      body.runtime_min < 0 ||
      body.runtime_min > 100000
    ) {
      return NextResponse.json({ error: "invalid_runtime" }, { status: 400 });
    }
    runtimeMin = body.runtime_min;
  }

  const synopsis = body.synopsis?.trim() || null;

  // --- slug: always server-generated (no partner override), unique table-wide ---
  let slugValue: string;
  try {
    slugValue = await resolveUniqueSlug(supabase, baseTitleSlug(title, year));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { error: msg },
      { status: msg === "slug_unresolvable" ? 409 : 500 },
    );
  }

  // --- insert: partner_id = the PATH partner (server-derived), NOT publicly live ---
  const { data: titleRow, error: titleErr } = await supabase
    .from("titles")
    .insert({
      slug: slugValue,
      title,
      media_type: mediaType,
      year,
      synopsis,
      runtime_min: runtimeMin,
      partner_id: partner.id, // <-- from the PATH + membership, never the body
      is_active: true,
      is_public: false, // not publicly live until it has a published asset + review
      is_featured: false,
      created_by: user.id,
      tmdb_id: null,
    })
    .select(
      "id, slug, title, year, media_type, partner_id, is_active, is_public",
    )
    .single();

  if (titleErr) {
    // 23505 = slug raced between our check and the insert.
    if (titleErr.code === "23505") {
      return NextResponse.json({ error: "slug_taken" }, { status: 409 });
    }
    return NextResponse.json({ error: titleErr.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, title: titleRow });
}
