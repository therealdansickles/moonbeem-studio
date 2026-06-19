// GET /api/titles/[id]/poster/presign?ext=jpg — mint a presigned R2 PUT url for
// a poster file upload. NET-NEW: deliberately NOT /api/admin/r2/presign (that
// route is requireSuperAdmin-only and would silently break the owning-partner-
// admin branch of our gate). Gated by authorizeTitleMutation — the SAME gate as
// the poster PATCH — so super-admins AND owning-partner-admins can upload.
//
// The browser PUTs the file directly to the returned url (presigned-direct,
// mirroring the partner-logo flow); the DB write-back happens in the poster
// PATCH (which resolves the returned key → poster_url). This route does NOT
// write the DB.

import { NextResponse, type NextRequest } from "next/server";
import { getUser } from "@/lib/dal";
import { enforce } from "@/lib/ratelimit";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { authorizeTitleMutation } from "@/lib/auth/title-mutation";
import { buildPosterKey, generatePresignedUploadUrl } from "@/lib/r2/upload";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Posters are photographic — jpeg/png/webp only. SVG is excluded (an XSS
// surface in an <img src> on public pages); avif is excluded (uneven decode
// support). Content-type is derived HERE from the ext allowlist, never trusted
// from the client. Mirrors the still allowlist minus svg/avif.
const POSTER_CONTENT_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getUser();
  if (!user) {
    return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  }
  const rl = await enforce("partnerWrites", user.id, "titles/poster/presign");
  if (!rl.ok) return rl.response;

  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "title_not_found" }, { status: 404 });
  }

  // AUTHORIZE FIRST — super_admin OR owning-partner-admin (same gate + mapping
  // as the poster PATCH).
  const authz = await authorizeTitleMutation(user.id, id);
  if (!authz.ok) {
    const status =
      authz.reason === "not_authenticated"
        ? 401
        : authz.reason === "title_not_found"
          ? 404
          : 403;
    return NextResponse.json({ error: authz.reason }, { status });
  }

  const ext = (request.nextUrl.searchParams.get("ext") ?? "").toLowerCase();
  const contentType = POSTER_CONTENT_TYPES[ext];
  if (!contentType) {
    return NextResponse.json({ error: "invalid_ext" }, { status: 400 });
  }

  // Resolve the slug for the key (authz already proved the title exists + the
  // caller's access). The key path uses the slug, mirroring the logo/still keys.
  const supabase = createServiceRoleClient();
  const { data: title } = await supabase
    .from("titles")
    .select("slug")
    .eq("id", id)
    .maybeSingle();
  if (!title) {
    return NextResponse.json({ error: "title_not_found" }, { status: 404 });
  }
  const slug = title.slug as string;

  const key = buildPosterKey(slug, ext);
  const suggestedFilename = `${slug}-poster.${ext}`;
  const { url, contentDisposition } = await generatePresignedUploadUrl(
    key,
    contentType,
    suggestedFilename,
  );
  return NextResponse.json({ url, key, contentType, contentDisposition });
}
