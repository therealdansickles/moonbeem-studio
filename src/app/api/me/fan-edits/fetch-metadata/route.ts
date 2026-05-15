// User-facing mirror of /api/admin/fan-edits/fetch-metadata.
// Gated to verified-tier users only (upload_fan_edit capability).
// Same preview-only EnsembleData fetch + R2 thumbnail proxy as the
// admin route; the auth surface is the only thing that differs.

import { NextResponse, type NextRequest } from "next/server";
import { verifySession } from "@/lib/dal";
import { enforce } from "@/lib/ratelimit";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { parseFanEditUrl, resolveFanEditUrl } from "@/lib/fan-edits/url-parser";
import { fetchEngagementMetrics } from "@/lib/ensembledata/client";
import { proxyThumbnailToR2 } from "@/lib/fan-edits/thumbnail-proxy";
import { getUserTier } from "@/lib/gating/get-user-tier";
import { canPerform } from "@/lib/gating/can-perform";

type Body = { url?: string };

export async function POST(request: NextRequest) {
  const session = await verifySession();
  const rl = await enforce(
    "userWrites",
    session.userId,
    "me/fan-edits/fetch-metadata",
  );
  if (!rl.ok) return rl.response;

  const tier = await getUserTier(session.userId);
  const gate = canPerform(tier, "upload_fan_edit");
  if (!gate.allowed) {
    return NextResponse.json(
      { error: gate.reason ?? "not_allowed" },
      { status: 403 },
    );
  }

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

  const resolved = await resolveFanEditUrl(rawUrl);
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.reason }, { status: 400 });
  }
  const parsed = parseFanEditUrl(resolved.url);
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

  let proxiedThumbnailUrl: string | null = null;
  if (metrics.thumbnail_url) {
    proxiedThumbnailUrl = await proxyThumbnailToR2({
      platform: parsed.platform,
      postId: parsed.contentId,
      thumbnailUrl: metrics.thumbnail_url,
    });
  }

  const postTypeLabel = derivePostTypeLabel(
    parsed.platform,
    metrics.raw_payload,
  );

  return NextResponse.json({
    ok: true,
    parsed,
    metrics: {
      ...metrics,
      thumbnail_url: proxiedThumbnailUrl ?? metrics.thumbnail_url,
    },
    sourceHandle:
      parsed.handle ?? metrics.creator_handle_displayed ?? null,
    postTypeLabel,
  });
}

function derivePostTypeLabel(
  platform: string,
  rawPayload: unknown,
): string | null {
  if (platform !== "instagram") return null;
  if (!rawPayload || typeof rawPayload !== "object") return null;
  const data = (rawPayload as Record<string, unknown>).data;
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const typeName = typeof d.__typename === "string" ? d.__typename : "";
  const likesHidden = d.like_and_view_counts_disabled === true;
  let base: string;
  if (typeName === "GraphSidecar" || typeName === "XDTGraphSidecar") {
    base = "Photo carousel";
  } else if (typeName === "GraphImage" || typeName === "XDTGraphImage") {
    base = "Single photo";
  } else if (d.is_video === true) {
    base = "Reel";
  } else if (typeName) {
    base = "Post";
  } else {
    return null;
  }
  return likesHidden ? `${base} · likes hidden` : base;
}

// Service-role unused in this route body but the import resolves the
// dependency graph; the linter will flag if unused. Kept inline to
// match the admin route's pattern; remove if we strip the resolver
// from the response.
void createServiceRoleClient;
