// Preview-only EnsembleData fetch for the single-URL admin upload UI.
// Returns parsed URL info + metrics so the admin can verify what
// they're about to attribute before saving. No DB writes.
//
// The /single endpoint accepts the same metrics back from the client
// (cached in component state) so we don't pay a second EnsembleData
// call per upload session.

import { NextResponse, type NextRequest } from "next/server";
import { requireSuperAdmin } from "@/lib/dal";
import { enforce } from "@/lib/ratelimit";
import { parseFanEditUrl } from "@/lib/fan-edits/url-parser";
import { fetchEngagementMetrics } from "@/lib/ensembledata/client";

type Body = { url?: string };

export async function POST(request: NextRequest) {
  const session = await requireSuperAdmin();
  const limit = await enforce(
    "admin",
    session.userId,
    "admin/fan-edits/fetch-metadata",
  );
  if (!limit.ok) return limit.response;

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const rawUrl = (body.url ?? "").trim();
  if (!rawUrl) {
    return NextResponse.json({ error: "url required" }, { status: 400 });
  }

  const parsed = parseFanEditUrl(rawUrl);
  if (!parsed) {
    return NextResponse.json(
      {
        error:
          "URL not recognized. Supported: TikTok, Instagram, X/Twitter, YouTube.",
      },
      { status: 400 },
    );
  }

  const metrics = await fetchEngagementMetrics({
    platform: parsed.platform,
    embed_url: parsed.normalizedUrl,
  });

  // EnsembleData errors come back as metrics.error — surface to the
  // client so the admin can decide to retry or proceed without
  // metadata. The insert path tolerates null metrics.
  return NextResponse.json({
    ok: true,
    parsed,
    metrics,
  });
}
