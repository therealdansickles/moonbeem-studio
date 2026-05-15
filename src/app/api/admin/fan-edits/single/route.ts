// Single-URL admin fan-edit insert.
//
// Expects the body to carry the URL + the title attribution + the
// metrics object that came back from /fetch-metadata (so we don't
// re-spend an EnsembleData call on the save). Optional caption / notes
// / handle override come from the form.

import { NextResponse, type NextRequest } from "next/server";
import { requireSuperAdmin } from "@/lib/dal";
import { enforce } from "@/lib/ratelimit";
import { parseFanEditUrl } from "@/lib/fan-edits/url-parser";
import { adminInsertFanEdit } from "@/lib/fan-edits/insert";
import type { FetchEngagementResult } from "@/lib/ensembledata/client";

type Body = {
  url?: string;
  title_id?: string;
  handle?: string | null;
  caption?: string | null;
  notes?: string | null;
  // Cached preview metrics — passed through to skip a second fetch.
  // Null/omitted forces the inserter to re-fetch.
  metrics?: FetchEngagementResult | null;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: NextRequest) {
  const session = await requireSuperAdmin();
  const limit = await enforce(
    "admin",
    session.userId,
    "admin/fan-edits/single",
  );
  if (!limit.ok) return limit.response;

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  if (!body.url) {
    return NextResponse.json({ error: "url required" }, { status: 400 });
  }
  if (!body.title_id || !UUID_RE.test(body.title_id)) {
    return NextResponse.json(
      { error: "title_id required (valid UUID)" },
      { status: 400 },
    );
  }

  const parsed = parseFanEditUrl(body.url);
  if (!parsed) {
    return NextResponse.json(
      { error: "URL not recognized for any supported platform" },
      { status: 400 },
    );
  }

  // Admin can override the parsed handle (rare but cheap to support).
  const handle =
    body.handle && body.handle.trim() ? body.handle : parsed.handle;

  // Notes are an admin-internal scratch field; the schema doesn't
  // store them yet. Today we log them server-side for traceability
  // and surface in the response. Caption (post body) IS persisted.
  if (body.notes && body.notes.trim()) {
    console.log("[admin/single] notes", {
      userId: session.userId,
      titleId: body.title_id,
      url: parsed.normalizedUrl,
      notes: body.notes.slice(0, 500),
    });
  }

  const result = await adminInsertFanEdit({
    titleId: body.title_id,
    embedUrl: parsed.normalizedUrl,
    platform: parsed.platform,
    postId: parsed.contentId,
    handle,
    caption: body.caption ?? null,
    prefetchedMetrics: body.metrics ?? null,
  });

  if (!result.ok) {
    const status = result.kind === "duplicate" ? 409 : 400;
    return NextResponse.json({ error: result.reason, kind: result.kind }, {
      status,
    });
  }

  return NextResponse.json({
    ok: true,
    fan_edit_id: result.fanEditId,
    creator_id: result.creatorId,
  });
}
