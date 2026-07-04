// GET /api/titles/[id]/episodes/[episodeId]/subtitles/presign?ext=vtt&lang=en
//
// Mint a presigned R2 PUT url for a subtitle file. NET-NEW, mirrors the poster
// presign: gated by authorizeTitleMutation (super-admin OR owning-partner-admin),
// content-type derived from the ext allowlist (never trusted from the client), key
// built from the resolved slug + episode + lang. The browser PUTs the file directly;
// the attach route (POST .../subtitles) does the DB write + Mux createTrack.

import { NextResponse, type NextRequest } from "next/server";
import { getUser } from "@/lib/dal";
import { enforce } from "@/lib/ratelimit";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { authorizeTitleMutation } from "@/lib/auth/title-mutation";
import { buildSubtitleKey, generatePresignedUploadUrl } from "@/lib/r2/upload";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Content-type derived HERE from the ext allowlist, never from the client.
const SUBTITLE_CONTENT_TYPES: Record<string, string> = {
  vtt: "text/vtt",
  srt: "application/x-subrip",
};
const LANG_RE = /^[a-z]{2}(?:-[a-z0-9]{2,8})?$/i; // BCP-47 lite: en, en-US, es-419

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; episodeId: string }> },
) {
  const user = await getUser();
  if (!user) {
    return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  }
  const rl = await enforce("partnerWrites", user.id, "titles/subtitles/presign");
  if (!rl.ok) return rl.response;

  const { id, episodeId } = await params;
  if (!UUID_RE.test(id) || !UUID_RE.test(episodeId)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

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
  const contentType = SUBTITLE_CONTENT_TYPES[ext];
  if (!contentType) {
    return NextResponse.json({ error: "invalid_ext" }, { status: 400 });
  }
  const lang = (request.nextUrl.searchParams.get("lang") ?? "").trim();
  if (!LANG_RE.test(lang)) {
    return NextResponse.json({ error: "invalid_lang" }, { status: 400 });
  }

  const supabase = createServiceRoleClient();
  const { data: title } = await supabase
    .from("titles")
    .select("slug")
    .eq("id", id)
    .maybeSingle();
  if (!title) {
    return NextResponse.json({ error: "title_not_found" }, { status: 404 });
  }
  // The episode must belong to this title and be a Mux asset (a track attaches to
  // the asset). Anti-cross-title + fail-fast before minting the upload.
  const { data: ep } = await supabase
    .from("title_episodes")
    .select("id, mux_asset_id, source")
    .eq("id", episodeId)
    .eq("title_id", id)
    .maybeSingle();
  if (!ep || ep.source !== "mux" || !ep.mux_asset_id) {
    return NextResponse.json({ error: "episode_not_mux" }, { status: 400 });
  }

  const key = buildSubtitleKey(title.slug as string, episodeId, lang, ext);
  const { url, contentDisposition } = await generatePresignedUploadUrl(
    key,
    contentType,
    `${title.slug}-${lang}.${ext}`,
  );
  return NextResponse.json({ url, key, contentType, contentDisposition });
}
