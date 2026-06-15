// Partner-admin endpoint for setting a clip's display label.
//
// PATCH /api/p/[slug]/clips/[id]
// Body: { label }  — ONLY label. The clip's title_id is DERIVED from the clip
// row, NEVER taken from the request body, and the ownership check + the write
// both key off it.
// Auth: mirrors /api/p/[slug]/title-rates exactly — caller must be in
// partner_users with role='admin' for this partner; super_admin bypasses the
// membership check but is STILL scoped to the slug's partner (not special-cased
// past it). Extended by ONE hop: clip -> its title -> that title's partner must
// equal the slug's partner.
//
// No migration: clips.label is the existing public display-name field, rendered
// as `clip.label?.trim() || fileNameFromUrl(file_url)` in VideosTab. An empty/
// whitespace label is stored as null so the render falls back to the filename
// (`null?.trim()` -> undefined -> the `||` filename branch).

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentProfile, getUser } from "@/lib/dal";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { enforce } from "@/lib/ratelimit";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LABEL_MAX_LENGTH = 200; // mirrors campaigns NAME_MAX_LENGTH

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string; id: string }> },
) {
  // --- Auth chain (verbatim from title-rates) ---
  const user = await getUser();
  if (!user) {
    return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  }
  const limit = await enforce("partnerWrites", user.id, "p/clips");
  if (!limit.ok) return limit.response;
  const { slug, id } = await params;
  const supabase = createServiceRoleClient();

  const { data: partner } = await supabase
    .from("partners")
    .select("id")
    .eq("slug", slug)
    .maybeSingle();
  if (!partner) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // super_admin bypasses partner_users check (matches /p/[slug] page-level
  // access). Otherwise the caller must be a partner_users member role='admin'.
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

  // --- Input: body carries ONLY { label }; never a title_id/partner_id ---
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "invalid_clip_id" }, { status: 400 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const labelRaw = (body as Record<string, unknown>)?.label;
  if (typeof labelRaw !== "string") {
    return NextResponse.json({ error: "invalid_label" }, { status: 400 });
  }
  const trimmed = labelRaw.trim();
  if (trimmed.length > LABEL_MAX_LENGTH) {
    return NextResponse.json({ error: "label_too_long" }, { status: 400 });
  }
  // Empty/whitespace-only -> null so the public render falls back to filename.
  const nextLabel = trimmed.length > 0 ? trimmed : null;

  // --- OWNERSHIP VERIFY (load-bearing): clip -> title -> partner, server-side,
  //     title_id derived from the clip row, never the request body ---
  // 1. The clip must exist and not be soft-deleted.
  const { data: clip } = await supabase
    .from("clips")
    .select("id, title_id, deleted_at")
    .eq("id", id)
    .maybeSingle();
  if (!clip || clip.deleted_at !== null) {
    return NextResponse.json({ error: "clip_not_found" }, { status: 404 });
  }
  // 2. The clip's title's owning partner.
  const { data: title } = await supabase
    .from("titles")
    .select("partner_id")
    .eq("id", clip.title_id)
    .maybeSingle();
  // 3. That partner must be THIS slug's partner. Nullable partner_id (unowned
  //    title) is rejected; super_admin is still bound to the slug's partner.
  if (!title || title.partner_id === null || title.partner_id !== partner.id) {
    return NextResponse.json({ error: "clip_not_in_partner" }, { status: 403 });
  }

  // --- Write: set the label on this clip. .eq("title_id") is a belt-and-
  //     suspenders re-scope (the ownership check above already gated it). ---
  const { error: updErr } = await supabase
    .from("clips")
    .update({ label: nextLabel })
    .eq("id", clip.id)
    .eq("title_id", clip.title_id);
  if (updErr) {
    return NextResponse.json({ error: updErr.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, id: clip.id, label: nextLabel });
}
