// POST /api/admin/titles/[slug]/discover/add
//
// Inserts fan_edits rows from the Discover tab. Two payload shapes,
// branched server-side:
//
//   1) { posts: Candidate[] }   — selected from a /discover/search
//      response. Each post already carries full metadata; we trust
//      it and skip the EnsembleData round-trip. Fast path.
//
//   2) { url: string }          — Add-by-URL fallback. Fetches the
//      post details via the existing fetchEngagementMetrics client
//      so the inserted row has counts + thumbnail. One EnsembleData
//      unit per call.
//
// Both paths funnel through insertFanEditCandidate, which mirrors
// the CSV importer's per-row logic (dedupe by embed_url, resolve
// stub creator, insert with view_tracking_status='active'). New
// rows get picked up by view-tracking on its next cron tick — no
// special trigger needed.
//
// Super-admin gated. Returns aggregate counters + per-candidate
// outcomes so the UI can mark each row as Added / Already / Failed.

import { NextResponse, type NextRequest } from "next/server";
import { requireSuperAdmin } from "@/lib/dal";
import { createServiceRoleClient } from "@/lib/supabase/service";
import {
  insertFanEditCandidate,
  type FanEditCandidate,
  type InsertOutcome,
} from "@/lib/fan-edits-insert";
import {
  fetchEngagementMetrics,
  parseShortcodeFromUrl,
} from "@/lib/ensembledata/client";

type SearchCandidatePayload = {
  post_id?: unknown;
  post_url?: unknown;
  author_handle?: unknown;
  caption?: unknown;
  view_count?: unknown;
  like_count?: unknown;
  comment_count?: unknown;
  share_count?: unknown;
  thumbnail_url?: unknown;
  // Unix seconds per TikTok create_time. Converted to ISO before
  // insert into fan_edits.posted_at (timestamptz).
  posted_at?: unknown;
};

type ResultEntry = {
  embed_url: string;
  outcome: "added" | "duplicate" | "failed";
  inserted_id?: string;
  existing_id?: string;
  error?: string;
};

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  await requireSuperAdmin();
  const { slug } = await params;

  let body: { posts?: unknown; url?: unknown };
  try {
    body = (await request.json()) as { posts?: unknown; url?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

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

  // Branch on payload shape. Reject ambiguous bodies (both posts AND
  // url present) so the caller is forced to be explicit.
  const hasPosts = Array.isArray(body.posts);
  const hasUrl = typeof body.url === "string" && body.url.trim() !== "";
  if (hasPosts && hasUrl) {
    return NextResponse.json(
      { error: "ambiguous_body" },
      { status: 400 },
    );
  }
  if (!hasPosts && !hasUrl) {
    return NextResponse.json({ error: "empty_body" }, { status: 400 });
  }

  const candidates: FanEditCandidate[] = [];
  const upfrontErrors: ResultEntry[] = [];

  if (hasPosts) {
    const posts = body.posts as SearchCandidatePayload[];
    if (posts.length === 0) {
      return NextResponse.json({ error: "empty_posts" }, { status: 400 });
    }
    if (posts.length > 100) {
      return NextResponse.json({ error: "too_many_posts" }, { status: 400 });
    }
    for (const p of posts) {
      const candidate = candidateFromSearchPayload(p);
      if (!candidate) {
        upfrontErrors.push({
          embed_url:
            typeof p.post_url === "string" ? (p.post_url as string) : "(unknown)",
          outcome: "failed",
          error: "invalid_payload_shape",
        });
        continue;
      }
      candidates.push(candidate);
    }
  } else {
    const rawUrl = (body.url as string).trim();
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(rawUrl);
    } catch {
      return NextResponse.json({ error: "invalid_url" }, { status: 400 });
    }
    const platform = inferPlatformFromHost(parsedUrl.hostname);
    if (!platform) {
      return NextResponse.json(
        { error: "platform_unknown_for_url" },
        { status: 400 },
      );
    }
    const shortcode = parseShortcodeFromUrl(rawUrl, platform);
    if (!shortcode) {
      return NextResponse.json(
        { error: "url_unparseable_for_platform", platform },
        { status: 400 },
      );
    }

    // Fetch live metadata from EnsembleData. fetchEngagementMetrics
    // returns nulls for unparseable / not-found / private; we fall
    // back to inserting a minimal row so the partner still sees the
    // URL even if metrics are pending.
    const metrics = await fetchEngagementMetrics({
      platform,
      embed_url: rawUrl,
    });
    if (metrics.error === "not_found") {
      return NextResponse.json(
        { error: "post_not_found_at_provider" },
        { status: 404 },
      );
    }

    candidates.push({
      platform,
      embed_url: rawUrl,
      creator_handle: handleFromUrl(parsedUrl, platform),
      caption: null,
      posted_at: null,
      thumbnail_url: metrics.thumbnail_url,
      view_count: metrics.view_count,
      like_count: metrics.like_count,
      comment_count: metrics.comment_count,
      share_count: metrics.share_count,
      duration_seconds: metrics.duration_seconds,
      aspect_ratio: metrics.aspect_ratio ?? undefined,
    });
  }

  const results: ResultEntry[] = [...upfrontErrors];
  let added = 0;
  let duplicate = 0;
  let failed = upfrontErrors.length;

  for (const c of candidates) {
    const outcome = await insertFanEditCandidate(supabase, titleId, c);
    results.push(toResultEntry(c.embed_url, outcome));
    if (outcome.ok) added += 1;
    else if (outcome.reason === "duplicate") duplicate += 1;
    else failed += 1;
  }

  return NextResponse.json({
    ok: failed === 0,
    added,
    duplicate,
    failed,
    results,
  });
}

function toResultEntry(embed_url: string, o: InsertOutcome): ResultEntry {
  if (o.ok) return { embed_url, outcome: "added", inserted_id: o.inserted_id };
  if (o.reason === "duplicate") {
    return { embed_url, outcome: "duplicate", existing_id: o.existing_id };
  }
  return { embed_url, outcome: "failed", error: `${o.reason}: ${o.detail}` };
}

function candidateFromSearchPayload(
  p: SearchCandidatePayload,
): FanEditCandidate | null {
  const post_url = typeof p.post_url === "string" ? p.post_url : null;
  const handle =
    typeof p.author_handle === "string" ? p.author_handle : null;
  if (!post_url || !handle) return null;
  return {
    platform: "tiktok",
    embed_url: post_url,
    creator_handle: handle,
    caption: typeof p.caption === "string" && p.caption ? p.caption : null,
    posted_at: unixSecondsToIso(p.posted_at),
    thumbnail_url:
      typeof p.thumbnail_url === "string" ? p.thumbnail_url : null,
    view_count: numberOrNull(p.view_count),
    like_count: numberOrNull(p.like_count),
    comment_count: numberOrNull(p.comment_count),
    share_count: numberOrNull(p.share_count),
  };
}

function numberOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// TikTok aweme.create_time → ISO string. Returns null when missing
// or not a positive number — fan_edits.posted_at is nullable.
function unixSecondsToIso(v: unknown): string | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return null;
  return new Date(v * 1000).toISOString();
}

function inferPlatformFromHost(
  host: string,
): "tiktok" | "instagram" | "twitter" | "youtube" | null {
  const h = host.toLowerCase();
  if (h.endsWith("tiktok.com")) return "tiktok";
  if (h.endsWith("instagram.com")) return "instagram";
  if (h === "twitter.com" || h.endsWith(".twitter.com")) return "twitter";
  if (h === "x.com" || h.endsWith(".x.com")) return "twitter";
  if (h === "t.co") return "twitter";
  if (h.endsWith("youtube.com") || h === "youtu.be" || h.endsWith(".youtu.be")) {
    return "youtube";
  }
  return null;
}

// Best-effort handle extraction from a post URL pathname. Returns
// null when the pathname doesn't start with /@<handle>/ — caller
// inserts the row with no creator attribution in that case.
function handleFromUrl(
  parsed: URL,
  platform: "tiktok" | "instagram" | "twitter" | "youtube",
): string | null {
  const path = parsed.pathname;
  if (platform === "tiktok") {
    const m = path.match(/^\/@([^/]+)\//);
    return m ? m[1].toLowerCase() : null;
  }
  if (platform === "instagram") {
    // Instagram post URLs (/reel/<code>/, /p/<code>/) don't carry
    // the handle. Caller may need to backfill via post-info on a
    // future view-tracking tick (upsert.ts already does this for IG).
    return null;
  }
  if (platform === "twitter") {
    const m = path.match(/^\/([^/]+)\/status\//);
    return m ? m[1].toLowerCase() : null;
  }
  return null;
}
