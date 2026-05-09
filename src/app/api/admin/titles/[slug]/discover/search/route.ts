// POST /api/admin/titles/[slug]/discover/search
//
// Server-side proxy to EnsembleData TikTok keyword search for the
// Discover tab on /admin/titles/[slug]. Body:
//   {
//     platform: 'tiktok'              // v1 hard-restricts to tiktok
//     query: string                    // keyword(s)
//     max_results?: number = 30        // clamped 1..100
//     period?: '1d'|'7d'|'30d'|'90d'|'180d'|'all' = '180d'
//   }
//
// Returns:
//   {
//     ok: true,
//     candidates: [{ ...Candidate, already_in_library: boolean }],
//     units_estimated: number,
//     pages_fetched: number,
//     results_count: number,
//     warning?: string                  // when search returned non-fatal error
//   }
//
// Side-effect: inserts one row into discovery_searches for cost
// monitoring (followup will surface this on /admin/usage).
//
// Super-admin gated. Vercel Node runtime (default) — no Edge crypto
// concerns and we want full Node fetch behaviour for the EnsembleData
// call.

import { NextResponse, type NextRequest } from "next/server";
import { requireSuperAdmin } from "@/lib/dal";
import { createServiceRoleClient } from "@/lib/supabase/service";
import {
  searchTikTokKeyword,
  type SearchPeriod,
} from "@/lib/ensembledata/search";

const VALID_PERIODS: ReadonlyArray<SearchPeriod> = [
  "1d",
  "7d",
  "30d",
  "90d",
  "180d",
  "all",
];

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

  const platform = typeof body.platform === "string" ? body.platform : "";
  if (platform !== "tiktok") {
    // IG/Twitter are surfaced in the UI as "coming soon" but the
    // server still rejects defensively in case the client gets out
    // of sync with the v1 platform whitelist.
    return NextResponse.json(
      { error: "platform_not_supported", supported: ["tiktok"] },
      { status: 400 },
    );
  }
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

  const result = await searchTikTokKeyword({
    query,
    max_results: maxResults,
    period,
  });

  // Filter image-only posts — we only want videos in fan_edits.
  const videoOnly = result.candidates.filter((c) => c.is_video);

  // Dedupe against existing fan_edits for THIS title only. A TikTok
  // attached to a different title still surfaces as available so
  // multi-title attribution is possible.
  const candidateUrls = videoOnly.map((c) => c.post_url);
  let alreadyUrls = new Set<string>();
  if (candidateUrls.length > 0) {
    const { data: existing } = await supabase
      .from("fan_edits")
      .select("embed_url")
      .eq("title_id", titleId)
      .in("embed_url", candidateUrls);
    alreadyUrls = new Set(
      (existing ?? [])
        .map((r) => r.embed_url as string | null)
        .filter((u): u is string => !!u),
    );
  }

  const enriched = videoOnly
    .map((c) => ({ ...c, already_in_library: alreadyUrls.has(c.post_url) }))
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

  return NextResponse.json({
    ok: true,
    candidates: enriched,
    units_estimated: result.units_estimated,
    pages_fetched: result.pages_fetched,
    results_count: enriched.length,
    warning: result.error ?? null,
  });
}
