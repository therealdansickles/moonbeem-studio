// GET /api/panel/clips — Bearer-authed browsable catalog for the Premiere panel
// (PANEL_ENDPOINT_SPEC, RATIFIED 2026-07-06). Returns public titles that have
// live clips, clips nested, plus a `viewer` block (the panel's bootstrap call;
// subsumes the parked whoami). The `title_id` variant returns one title.
//
// Auth pipeline mirrors GET /api/panel/clips/[id]/download EXACTLY (the Stage-3
// route): param shape → IP rate limit BEFORE token lookup → verifyApiToken →
// requireScope("clip:list") → verified-creator gate → service-role reads. NO
// logUserEvent — browsing is not a content pull (traceability stays on the
// download route). Thumbnails are composed server-side (§6a); file_url and
// poster_url never reach the wire.
//
// MONEY BOUNDARY: content-only. Imports ONLY token auth (verifyApiToken/
// requireScope), the verification tier check (getUserTier), the rate-limiter
// (enforce/getIp), the service-role client, the shared clip listing layer, and
// the panel thumbnail composer. NO earnings/metering/withdraw/campaign-billing/
// stripe code. The token scope is content-only; no money action is reachable.

import { NextResponse, type NextRequest } from "next/server";
import { verifyApiToken, requireScope } from "@/lib/api-tokens/verify";
import { getUserTier } from "@/lib/gating/get-user-tier";
import { enforce, getIp } from "@/lib/ratelimit";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { listClipsForTitle } from "@/lib/queries/titles";
import { composeTitleThumbnails } from "@/lib/panel/thumbnail";
import { parsePage, parseLimit, paginate, toClipWire } from "@/lib/panel/catalog";

// Mux thumbnail JWT signing (for DRM titles) runs on Node crypto — pin runtime.
export const runtime = "nodejs";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;

  // (1) Param shape first — a malformed title_id is a 400 before any work.
  const titleIdParam = params.get("title_id");
  if (titleIdParam !== null && !UUID_RE.test(titleIdParam)) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  // (2) IP-keyed rate limit BEFORE the token lookup — a garbage Bearer must hit
  // an IP cap before the SHA-256 + api_tokens lookup (tightAnon = 10/min).
  const rl = await enforce("tightAnon", getIp(request), "panel/clips/list");
  if (!rl.ok) return rl.response;

  // (3) Authenticate by Bearer API token (null ⇒ any failure mode).
  const auth = await verifyApiToken(request);
  if (!auth) {
    return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  }

  // (4) Authorize the action — the new list scope, separate from clip:download.
  const denied = requireScope(auth, "clip:list");
  if (denied) return denied;

  // (5) Verified-creator gate (literal comparison, as the download route).
  const tier = await getUserTier(auth.userId);
  if (tier !== "verified") {
    return NextResponse.json({ error: "not_verified" }, { status: 403 });
  }

  // (6) Service-role reads (api_tokens is deny-all; clips read via service-role).
  const supabase = createServiceRoleClient();

  const page = parsePage(params.get("page"));
  const limit = parseLimit(params.get("limit"));

  // viewer block — resolve the token's creator by PK (handle/display_name nullable).
  const { data: creatorRow } = await supabase
    .from("creators")
    .select("moonbeem_handle, display_name")
    .eq("id", auth.creatorId)
    .maybeSingle();
  const viewer = {
    creator_id: auth.creatorId,
    handle: (creatorRow?.moonbeem_handle as string | null) ?? null,
    display_name: (creatorRow?.display_name as string | null) ?? null,
  };

  // §5 query — NEVER scan titles by is_public (1.43M rows, unindexed → ~25s seq
  // scan). Drive from clips (176 rows): distinct clip title_ids, then titles by
  // PK with is_public/is_active/deleted_at as cheap post-filters on the bounded set.
  const { data: clipRows } = await supabase
    .from("clips")
    .select("title_id")
    .is("deleted_at", null);
  const clipTitleIds = Array.from(
    new Set((clipRows ?? []).map((r) => r.title_id as string)),
  );
  if (clipTitleIds.length === 0) {
    return NextResponse.json({ viewer, titles: [], page: 1, has_next: false });
  }

  let titlesQuery = supabase
    .from("titles")
    .select("id, slug, title, year, distributor, poster_url")
    .in("id", clipTitleIds)
    .eq("is_public", true)
    .eq("is_active", true)
    .is("deleted_at", null)
    .order("title", { ascending: true })
    .order("id", { ascending: true });
  if (titleIdParam) titlesQuery = titlesQuery.eq("id", titleIdParam);

  const { data: allTitles } = await titlesQuery;
  const titles = allTitles ?? [];

  // title_id variant: unknown / soft-deleted / not-public / not-active / no-clips
  // all collapse to 404 (the id wasn't in the public+live+has-clips set).
  if (titleIdParam && titles.length === 0) {
    return NextResponse.json({ error: "title_not_found" }, { status: 404 });
  }

  // Paginate (title_id variant is always the single element, page 1, no next).
  const { pageItems, hasNext } = titleIdParam
    ? { pageItems: titles, hasNext: false }
    : paginate(titles, page, limit);

  // Compose one thumbnail_url per page title (§6a), then the clips per title via
  // the shared listing layer verbatim (Promise.all; ≤50 indexed single-title reads).
  const posterByTitle = new Map<string, string | null>(
    pageItems.map((t) => [t.id as string, (t.poster_url as string | null) ?? null]),
  );
  const thumbByTitle = await composeTitleThumbnails(
    supabase,
    pageItems.map((t) => t.id as string),
    posterByTitle,
  );
  const clipsByTitle = await Promise.all(
    pageItems.map((t) => listClipsForTitle(supabase, t.id as string)),
  );

  const wireTitles = pageItems
    .map((t, i) => {
      const titleThumb = thumbByTitle.get(t.id as string) ?? null;
      const clips = clipsByTitle[i].map((c) => toClipWire(c, titleThumb));
      return {
        id: t.id as string,
        slug: t.slug as string,
        title: t.title as string,
        year: (t.year as number | null) ?? null,
        distributor: (t.distributor as string | null) ?? null,
        thumbnail_url: titleThumb,
        clip_count: clips.length,
        clips,
      };
    })
    // Drop titles that raced to zero live clips (never emit empty clips arrays).
    .filter((t) => t.clip_count > 0);

  return NextResponse.json({
    viewer,
    titles: wireTitles,
    page: titleIdParam ? 1 : page,
    has_next: hasNext,
  });
}
