// POST /api/me/hosting/titles — a CLAIMED CREATOR creates a new hosted film in
// their own catalog (the self-serve hosting lane's first step: create →
// upload). Mirrors POST /api/p/[slug]/titles with the partner-membership gate
// replaced by the CLAIMED-CREATOR gate:
//   * The new title's creator_id is the creators row CLAIMED by the session
//     user (creators.user_id = session userId, deleted_at IS NULL), resolved
//     SERVER-SIDE. It is NEVER read from the body.
//   * No claimed creator → 403 no_claimed_creator. (No 404 existence-hiding
//     here — the partner route hides OTHER people's partners; this resource is
//     the caller's own state.)
//   * No super_admin bypass on CREATE: creation is self-scoped — there is no
//     path param naming whose catalog to create into, so an admin without a
//     claimed creator has nothing to create under. The mutation gate
//     (authorizeCreatorTitleMutation) keeps the bypass for EXISTING titles.
//   * requires_drm=true from birth (ruling D3) and is_public=false (ruling Q2:
//     dashboard-only v1) — server-controlled, never body-settable.
//   * slug is server-generated, unique PER CREATOR (creator_titles is
//     UNIQUE(creator_id, slug)); there is no public /t/ URL in v1.
//   * Pricing/monetization/territory fields are NOT accepted — later phases;
//     the body is limited to safe descriptive fields.

import { NextResponse, type NextRequest } from "next/server";
import { getUser } from "@/lib/dal";
import { enforce } from "@/lib/ratelimit";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { baseTitleSlug } from "@/lib/titles/slug";
import { resolveUniqueCreatorTitleSlug } from "@/lib/creator-titles/slug";

const TITLE_MAX_LENGTH = 200;
const SYNOPSIS_MAX_LENGTH = 2000;

type Body = {
  title?: string;
  synopsis?: string | null;
  // NOTE: creator_id / slug / is_public / requires_drm are deliberately NOT
  // part of this type — they are server-controlled, never client-supplied.
};

export async function POST(request: NextRequest) {
  const user = await getUser();
  if (!user) {
    return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  }
  const rl = await enforce("creatorWrites", user.id, "me/hosting/titles");
  if (!rl.ok) return rl.response;

  const supabase = createServiceRoleClient();

  // CLAIMED-CREATOR GATE — the canonical caller-owns-creator predicate
  // (resolveCreatorId shape): creators.user_id = session user, live row. The
  // /me page only renders Hosting for claimed creators, so this is the
  // server-side gate that makes that rendering rule un-bypassable.
  const { data: creator } = await supabase
    .from("creators")
    .select("id")
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!creator) {
    return NextResponse.json({ error: "no_claimed_creator" }, { status: 403 });
  }

  // --- Body: ONLY safe descriptive fields. Any creator_id is ignored. ---
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

  if (body.synopsis != null && typeof body.synopsis !== "string") {
    return NextResponse.json({ error: "invalid_synopsis" }, { status: 400 });
  }
  const synopsis = body.synopsis?.trim() || null;
  if (synopsis && synopsis.length > SYNOPSIS_MAX_LENGTH) {
    return NextResponse.json({ error: "synopsis_too_long" }, { status: 400 });
  }

  // --- slug: server-generated, unique within THIS creator's namespace ---
  let slugValue: string;
  try {
    slugValue = await resolveUniqueCreatorTitleSlug(
      supabase,
      creator.id as string,
      baseTitleSlug(title, null),
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { error: msg },
      { status: msg === "slug_unresolvable" ? 409 : 500 },
    );
  }

  // --- insert: creator_id = the SESSION's claimed creator, dashboard-only ---
  const { data: titleRow, error: titleErr } = await supabase
    .from("creator_titles")
    .insert({
      creator_id: creator.id, // <-- from the session's claim, never the body
      slug: slugValue,
      title,
      synopsis,
      requires_drm: true, // D3: carried from birth (not surfaced in v1 UI)
      is_public: false, // Q2: dashboard-only v1 (Phase 6 owns going public)
      is_active: true,
    })
    .select("id, slug, title, synopsis, created_at")
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
