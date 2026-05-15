// Preview-only EnsembleData fetch for the single-URL admin upload UI.
// Returns parsed URL info + metrics so the admin can verify what
// they're about to attribute before saving. No fan_edits writes,
// but the thumbnail IS proxied to R2 (idempotent per post id) so
// the preview <img> renders reliably and the saved row already has
// a stable R2 URL — no second proxy on save.
//
// Also resolves the social handle to a Moonbeem creator via
// creator_socials so the UI can show "Attributed to <creator>" or
// "No registered creator" in the same response.

import { NextResponse, type NextRequest } from "next/server";
import { requireSuperAdmin } from "@/lib/dal";
import { enforce } from "@/lib/ratelimit";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { parseFanEditUrl, resolveFanEditUrl } from "@/lib/fan-edits/url-parser";
import { fetchEngagementMetrics } from "@/lib/ensembledata/client";
import { proxyThumbnailToR2 } from "@/lib/fan-edits/thumbnail-proxy";

type Body = { url?: string };

type ResolvedCreator = {
  id: string;
  moonbeem_handle: string;
  display_name: string | null;
  avatar_url: string | null;
  verified_at: string | null;
};

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

  // TikTok mobile-share URLs (vm./vt./tiktok.com/t/) don't carry the
  // canonical video id in the path — HEAD-follow to the final URL
  // before parsing. No-op for everything else.
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

  // Resolve the handle (parsed > metrics-returned) against
  // creator_socials so the UI can show auto-attribution status.
  const resolvedHandle =
    parsed.handle ?? metrics.creator_handle_displayed ?? null;
  let resolvedCreator: ResolvedCreator | null = null;
  if (resolvedHandle) {
    const sb = createServiceRoleClient();
    // creator_socials.unique on (platform, lower(handle))
    const { data: link } = await sb
      .from("creator_socials")
      .select("creator_id, verified_at")
      .eq("platform", parsed.platform)
      .ilike("handle", resolvedHandle)
      .maybeSingle();
    if (link?.creator_id) {
      const { data: creator } = await sb
        .from("creators")
        .select("id, moonbeem_handle, display_name, avatar_url")
        .eq("id", link.creator_id)
        .maybeSingle();
      if (creator) {
        resolvedCreator = {
          id: creator.id as string,
          moonbeem_handle: creator.moonbeem_handle as string,
          display_name: (creator.display_name as string | null) ?? null,
          avatar_url: (creator.avatar_url as string | null) ?? null,
          verified_at: (link.verified_at as string | null) ?? null,
        };
      }
    }
  }

  // Best-effort thumbnail proxy. On any failure we leave the
  // original (likely broken in-browser) URL in metrics.thumbnail_url
  // and let the save path retry — caller still gets a usable
  // response for the rest of the preview.
  let proxiedThumbnailUrl: string | null = null;
  if (metrics.thumbnail_url) {
    proxiedThumbnailUrl = await proxyThumbnailToR2({
      platform: parsed.platform,
      postId: parsed.contentId,
      thumbnailUrl: metrics.thumbnail_url,
    });
  }

  // Post-type label — surfaces "Photo carousel · likes hidden" / "Reel" /
  // "Single photo" beneath the metrics row so admins understand why
  // some IG fields render as "—". Derived from raw_payload when the
  // platform exposes the info; null for platforms that don't.
  const postTypeLabel = derivePostTypeLabel(parsed.platform, metrics.raw_payload);

  return NextResponse.json({
    ok: true,
    parsed,
    metrics: {
      ...metrics,
      // Overwrite with the R2 URL when proxy succeeded so the client
      // <img> renders reliably AND the cached metrics passed to
      // /single carry the R2 URL directly.
      thumbnail_url: proxiedThumbnailUrl ?? metrics.thumbnail_url,
    },
    resolvedCreator,
    sourceHandle: resolvedHandle,
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
  } else if (
    typeName === "GraphImage" ||
    typeName === "XDTGraphImage"
  ) {
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
