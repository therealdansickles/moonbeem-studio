// POST /api/admin/titles/[slug]/discover/search
//
// Server-side proxy to EnsembleData search for the Discover tab on
// /admin/titles/[slug]. Body:
//   {
//     platform: 'tiktok' | 'youtube',  // dispatched per-platform
//     query: string,                   // keyword(s) for tiktok,
//                                      // hashtag (with or without #)
//                                      // for youtube
//     max_results?: number = 30,       // clamped 1..100
//     period?: '1d'|'7d'|'30d'|'90d'|'180d'|'all' = '180d'
//                                      // tiktok-only; ignored for
//                                      // platforms whose endpoint
//                                      // doesn't accept a period
//                                      // filter (youtube hashtag).
//   }
//
// Returns:
//   {
//     ok: true,
//     candidates: [{ ...Candidate, already_in_library: boolean }],
//     units_estimated: number,
//     pages_fetched: number,
//     results_count: number,
//     warning?: string,                // missing_token / parse_error / etc.
//     debug?: { raw_payload_truncated: string }
//                                       // only on warning or 0 results
//   }
//
// Side-effect: inserts one row into discovery_searches per call for
// cost monitoring.
//
// Super-admin gated. The route is super_admin-only end-to-end, so
// the debug raw_payload return is always safe to include — there's
// no non-admin caller to leak to.

import { NextResponse, type NextRequest } from "next/server";
import { requireSuperAdmin } from "@/lib/dal";
import { createServiceRoleClient } from "@/lib/supabase/service";
import {
  searchTikTokKeyword,
  searchYouTubeHashtag,
  type SearchPeriod,
  type SearchResult,
} from "@/lib/ensembledata/search";

const VALID_PERIODS: ReadonlyArray<SearchPeriod> = [
  "1d",
  "7d",
  "30d",
  "90d",
  "180d",
  "all",
];

const SUPPORTED_PLATFORMS = ["tiktok", "youtube"] as const;
type SupportedPlatform = (typeof SUPPORTED_PLATFORMS)[number];

const RAW_PAYLOAD_MAX_BYTES = 5 * 1024;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const session = await requireSuperAdmin();
  const { slug } = await params;

  let body: {
    platform?: unknown;
    query?: unknown;
    max_results?: unknown;
    period?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const platformRaw = typeof body.platform === "string" ? body.platform : "";
  if (
    !(SUPPORTED_PLATFORMS as ReadonlyArray<string>).includes(platformRaw)
  ) {
    return NextResponse.json(
      {
        error: "platform_not_supported",
        supported: SUPPORTED_PLATFORMS,
      },
      { status: 400 },
    );
  }
  const platform = platformRaw as SupportedPlatform;
  const query = typeof body.query === "string" ? body.query.trim() : "";
  if (!query) {
    return NextResponse.json({ error: "missing_query" }, { status: 400 });
  }
  const maxResultsRaw =
    typeof body.max_results === "number" ? body.max_results : 30;
  const maxResults = Math.max(1, Math.min(Math.round(maxResultsRaw), 100));

  const periodRaw = typeof body.period === "string" ? body.period : "180d";
  const period = (VALID_PERIODS as ReadonlyArray<string>).includes(periodRaw)
    ? (periodRaw as SearchPeriod)
    : "180d";

  const supabase = createServiceRoleClient();
  const { data: title, error: titleErr } = await supabase
    .from("titles")
    .select("id")
    .eq("slug", slug)
    .is("deleted_at", null)
    .maybeSingle();
  if (titleErr) {
    return NextResponse.json({ error: titleErr.message }, { status: 500 });
  }
  if (!title) {
    return NextResponse.json({ error: "title_not_found" }, { status: 404 });
  }
  const titleId = title.id as string;

  let result: SearchResult;
  if (platform === "tiktok") {
    result = await searchTikTokKeyword({
      query,
      max_results: maxResults,
      period,
    });
  } else {
    // youtube — /youtube/hashtag/search doesn't accept a period
    // filter. The UI also doesn't expose period for YT.
    result = await searchYouTubeHashtag({
      query,
      max_results: maxResults,
    });
  }

  // parsePage already drops non-video (type !== 1) entries, so no
  // additional is_video filter needed here.
  const fetched = result.candidates;

  // Dedupe by platform-native post_id scoped to THIS title + platform.
  // embed_url string-equality leaks because legacy / CSV-imported rows
  // carry query strings (?_t=, ?q=erupcja, ?s=46 …) and mobile hosts
  // that don't match the canonical desktop URLs the parser constructs.
  // post_id is the canonical identifier and is backfilled + uniquely
  // indexed at the DB level (migration 20260509000006). A post
  // attached to a DIFFERENT title still surfaces as available —
  // multi-title attribution from 2.2's dedupe-within-title decision.
  // Platform filter prevents collision in the (extremely unlikely)
  // case that a TikTok aweme_id numerically matches a YouTube video_id.
  const candidatePostIds = fetched.map((c) => c.post_id);
  let alreadyPostIds = new Set<string>();
  if (candidatePostIds.length > 0) {
    const { data: existing } = await supabase
      .from("fan_edits")
      .select("post_id")
      .eq("title_id", titleId)
      .eq("platform", platform)
      .is("deleted_at", null)
      .not("post_id", "is", null)
      .in("post_id", candidatePostIds);
    alreadyPostIds = new Set(
      (existing ?? [])
        .map((r) => r.post_id as string | null)
        .filter((p): p is string => !!p),
    );
  }

  const enriched = fetched
    .map((c) => ({ ...c, already_in_library: alreadyPostIds.has(c.post_id) }))
    .sort((a, b) => (b.view_count ?? 0) - (a.view_count ?? 0));

  // Log the search regardless of error — partial pages still cost
  // units, and an error path is itself useful signal.
  await supabase.from("discovery_searches").insert({
    title_id: titleId,
    user_id: session.userId,
    platform,
    query,
    period,
    max_results: maxResults,
    results_count: enriched.length,
    units_estimated: result.units_estimated,
  });

  // Surface a truncated raw payload for in-DevTools debugging when
  // the parser couldn't extract candidates or zero results came back
  // — these are the cases where field-path drift is the likely
  // cause. Route is super_admin gated so this never reaches a
  // non-admin caller.
  const includeDebug =
    result.error === "parse_error" || enriched.length === 0;
  const debug = includeDebug
    ? { raw_payload_truncated: truncatePayload(result.raw_payload) }
    : undefined;

  return NextResponse.json({
    ok: true,
    candidates: enriched,
    units_estimated: result.units_estimated,
    pages_fetched: result.pages_fetched,
    results_count: enriched.length,
    warning: result.error ?? null,
    debug,
  });
}

function truncatePayload(payload: unknown): string {
  if (payload === undefined || payload === null) return "(empty)";
  let s: string;
  try {
    s = JSON.stringify(payload, null, 2);
  } catch {
    s = String(payload);
  }
  if (s.length <= RAW_PAYLOAD_MAX_BYTES) return s;
  return s.slice(0, RAW_PAYLOAD_MAX_BYTES) + "\n…(truncated)";
}
