// POST /api/titles/[id]/publish
//
// Make the TITLE publicly listed (titles.is_public false -> true). This is the
// DELIBERATE, separate go-live step — decoupled from per-episode publish
// (POST /api/titles/[id]/episodes/[episodeId]/publish) so a first upload never
// auto-lists the title across the homepage rails or leaks its name via
// OpenGraph. is_public gates BOTH /t/[slug] anon reachability (canViewTitle) AND
// catalog discoverability (getAllFilms/getSeriesTitles/getEventTitles all filter
// is_public=true); title_episodes.is_published is the orthogonal per-episode gate.
//
// SAFETY: refuse to publicly list a title that has no published episode (can't
// list an empty title). Auth = the same un-forgeable authorizeTitleMutation gate.

import { NextResponse, type NextRequest } from "next/server";
import { revalidatePath } from "next/cache";
import { getUser } from "@/lib/dal";
import { enforce } from "@/lib/ratelimit";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { authorizeTitleMutation } from "@/lib/auth/title-mutation";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getUser();
  if (!user) {
    return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  }
  const rl = await enforce("partnerWrites", user.id, "titles/publish");
  if (!rl.ok) return rl.response;

  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "title_not_found" }, { status: 404 });
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

  const supabase = createServiceRoleClient();

  // SAFETY: a title may only go public once it has at least one PUBLISHED
  // episode — never list an empty title.
  const { count: publishedCount } = await supabase
    .from("title_episodes")
    .select("id", { count: "exact", head: true })
    .eq("title_id", id)
    .eq("is_published", true);
  if (!publishedCount || publishedCount < 1) {
    return NextResponse.json({ error: "no_published_asset" }, { status: 409 });
  }

  // WRITE: idempotent flip, select-confirm. The public_requires_active CHECK
  // (is_public => is_active) surfaces as 23514 for an inactive title.
  const { data: updated, error: updErr } = await supabase
    .from("titles")
    .update({ is_public: true })
    .eq("id", id)
    .select("id, is_public, slug")
    .maybeSingle();
  if (updErr) {
    if (updErr.code === "23514") {
      return NextResponse.json({ error: "title_not_active" }, { status: 409 });
    }
    return NextResponse.json({ error: updErr.message }, { status: 500 });
  }
  if (!updated) {
    return NextResponse.json({ error: "title_not_found" }, { status: 404 });
  }

  // The title now appears in catalog rails (is_public=true) + is anon-reachable.
  revalidatePath("/");
  if (updated.slug) revalidatePath(`/t/${updated.slug as string}`);

  return NextResponse.json({ titleId: updated.id, is_public: updated.is_public });
}
