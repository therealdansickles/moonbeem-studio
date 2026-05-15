// User multi-URL preview — verified-tier only. Takes a list of pasted
// URLs (max 25), resolves TikTok short-links in parallel, parses each
// to platform/post_id/handle, and returns a per-row preview the
// client can review before commit.
//
// No DB writes; no EnsembleData fetches (those happen at commit
// time). Title attribution is the user's choice — they pick a single
// default and can override per row.

import { NextResponse, type NextRequest } from "next/server";
import { verifySession } from "@/lib/dal";
import { enforce } from "@/lib/ratelimit";
import {
  parseFanEditUrl,
  resolveFanEditUrl,
  type ResolveResult,
} from "@/lib/fan-edits/url-parser";
import { getUserTier } from "@/lib/gating/get-user-tier";
import { canPerform } from "@/lib/gating/can-perform";

const MAX_URLS = 25;

type Body = { urls?: string[] };

type PreviewRowOut = {
  idx: number;
  rawUrl: string;
  platform: string | null;
  contentId: string | null;
  normalizedUrl: string | null;
  handle: string | null;
  status: "ready" | "review" | "skip";
  error: string | null;
};

export async function POST(request: NextRequest) {
  const session = await verifySession();
  const rl = await enforce(
    "userWrites",
    session.userId,
    "me/fan-edits/bulk/preview",
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
  const urls = Array.isArray(body.urls)
    ? body.urls.map((u) => (typeof u === "string" ? u.trim() : "")).filter(Boolean)
    : [];
  if (urls.length === 0) {
    return NextResponse.json({ error: "urls[] required" }, { status: 400 });
  }
  if (urls.length > MAX_URLS) {
    return NextResponse.json(
      { error: `${MAX_URLS} URL limit (got ${urls.length})` },
      { status: 400 },
    );
  }

  // Parallel resolve short-links (no-op fast path for canonical URLs).
  const resolveCache = new Map<string, ResolveResult>();
  const unique = Array.from(new Set(urls));
  const CONC = 10;
  for (let i = 0; i < unique.length; i += CONC) {
    const batch = unique.slice(i, i + CONC);
    const results = await Promise.all(batch.map((u) => resolveFanEditUrl(u)));
    for (let j = 0; j < batch.length; j++) {
      resolveCache.set(batch[j], results[j]);
    }
  }

  const out: PreviewRowOut[] = urls.map((rawUrl, idx) => {
    const resolved = resolveCache.get(rawUrl);
    if (resolved && !resolved.ok) {
      return {
        idx,
        rawUrl,
        platform: null,
        contentId: null,
        normalizedUrl: null,
        handle: null,
        status: "skip",
        error: resolved.reason,
      };
    }
    const parsed = parseFanEditUrl(resolved?.ok ? resolved.url : rawUrl);
    if (!parsed) {
      return {
        idx,
        rawUrl,
        platform: null,
        contentId: null,
        normalizedUrl: null,
        handle: null,
        status: "skip",
        error: "unrecognized URL — supported: TikTok, Instagram, X, YouTube",
      };
    }
    return {
      idx,
      rawUrl,
      platform: parsed.platform,
      contentId: parsed.contentId,
      normalizedUrl: parsed.normalizedUrl,
      handle: parsed.handle,
      status: "ready",
      error: null,
    };
  });

  return NextResponse.json({
    ok: true,
    total: out.length,
    ready: out.filter((r) => r.status === "ready").length,
    skip: out.filter((r) => r.status === "skip").length,
    rows: out,
  });
}
