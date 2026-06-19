// PATCH /api/titles/[id]/poster — edit a title's poster_url (URL only; file
// upload to R2 is a deferred follow-on). Net-new: the existing
// /api/admin/titles/[slug] PATCH is super-admin-only and doesn't touch
// poster_url. This route is title-scoped (NOT under /api/admin) so an owning-
// partner-admin can use it too — authorization is the OR gate, not a path-level
// admin gate.
//
// Authorization is authorizeTitleMutation(user.id, titleId): super_admin OR the
// partner-admin that OWNS this title. The acting user.id is resolved server-side
// from the session; the helper resolves ownership internally (never from client
// input). Service-role write — the helper IS the gate (matches the 5 partner
// write routes).

import { NextResponse, type NextRequest } from "next/server";
import { revalidatePath } from "next/cache";
import { getUser } from "@/lib/dal";
import { enforce } from "@/lib/ratelimit";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { authorizeTitleMutation } from "@/lib/auth/title-mutation";
import { buildPublicUrl } from "@/lib/r2/upload";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Syntactic validation only — we do NOT fetch/verify the image, just ensure a
// well-formed absolute http(s) URL (rejects empty, non-URL, non-http(s) e.g.
// javascript:/data:/ftp:).
function isValidHttpUrl(s: string): boolean {
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return false;
  }
  return u.protocol === "http:" || u.protocol === "https:";
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  // Session user, resolved server-side (never trust client identity).
  const user = await getUser();
  if (!user) {
    return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  }
  // Same write-tier limiter the partner routes use.
  const rl = await enforce("partnerWrites", user.id, "titles/poster");
  if (!rl.ok) return rl.response;

  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "title_not_found" }, { status: 404 });
  }

  // AUTHORIZE FIRST — super_admin OR owning-partner-admin. Map the result.
  const authz = await authorizeTitleMutation(user.id, id);
  if (!authz.ok) {
    const status =
      authz.reason === "not_authenticated"
        ? 401
        : authz.reason === "title_not_found"
          ? 404
          : 403; // not_authorized
    return NextResponse.json({ error: authz.reason }, { status });
  }

  let body: { poster_url?: unknown; poster_key?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  // poster_key (from an R2 file upload via the presign route) takes precedence —
  // resolve it to a public URL server-side (R2_PUBLIC_URL is server-only).
  // Mirrors the partner-logo logo_key handling (partners/[id]/route.ts). Else
  // fall back to the paste-a-URL branch with its http(s) validation.
  const posterKey =
    typeof body.poster_key === "string" ? body.poster_key.trim() : "";
  let posterUrl: string;
  if (posterKey) {
    posterUrl = buildPublicUrl(posterKey);
  } else {
    const pasted =
      typeof body.poster_url === "string" ? body.poster_url.trim() : "";
    if (!pasted || !isValidHttpUrl(pasted)) {
      return NextResponse.json({ error: "invalid_url" }, { status: 400 });
    }
    posterUrl = pasted;
  }

  // Write via service-role (authorization already enforced in-app). Scope by the
  // title's own PK id — the resource is exactly the authorized title.
  const supabase = createServiceRoleClient();
  const { data: updated, error } = await supabase
    .from("titles")
    .update({ poster_url: posterUrl })
    .eq("id", id)
    .select("id, slug, poster_url")
    .maybeSingle();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!updated) {
    return NextResponse.json({ error: "title_not_found" }, { status: 404 });
  }

  // Propagate to the title page; cards elsewhere re-read on their own renders.
  revalidatePath(`/t/${updated.slug}`);

  return NextResponse.json({
    ok: true,
    poster_url: updated.poster_url,
    via: authz.via,
  });
}
