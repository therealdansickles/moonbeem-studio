import { NextResponse, after, type NextRequest } from "next/server";
import {
  notifyTitleRequesters,
  type ContentType,
} from "@/lib/notifications/notify-title-requesters";
import { drainQueue } from "@/lib/email-queue";
import { enforce, getIp } from "@/lib/ratelimit";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const VALID_TYPES: ContentType[] = ["clip", "still", "fan_edit"];

type Body = {
  content_type?: string;
  content_ids?: unknown;
};

export async function POST(
  request: NextRequest,
  // Segment name is `id` to match every sibling under /api/titles/[id]/*
  // (Next forbids two slug names — id vs title_id — at the same path level).
  // The route's semantics are unchanged: it still keys off the title id.
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY ?? ""}`;
  if (
    !process.env.SUPABASE_SERVICE_ROLE_KEY ||
    auth !== expected
  ) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Service-to-service endpoint (Bearer service-role gated). IP-keyed
  // admin tier serves as a leaked-key safety net — at 300/min per IP
  // a leaked key abuser is bounded without affecting legitimate batch
  // notify calls from our own admin upload routes (those run from
  // Vercel function IPs which would burn budget collectively, but the
  // limit is high enough that real upload bursts pass through).
  const limit = await enforce("admin", getIp(request), "titles/[id]/notify");
  if (!limit.ok) return limit.response;

  const { id: title_id } = await ctx.params;
  if (!UUID_RE.test(title_id)) {
    return NextResponse.json({ error: "invalid title_id" }, { status: 400 });
  }

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const contentType = body.content_type;
  if (!contentType || !VALID_TYPES.includes(contentType as ContentType)) {
    return NextResponse.json(
      { error: "content_type must be one of clip|still|fan_edit" },
      { status: 400 },
    );
  }

  const ids = Array.isArray(body.content_ids) ? body.content_ids : [];
  const contentIds = ids.filter(
    (v): v is string => typeof v === "string" && UUID_RE.test(v),
  );
  if (contentIds.length === 0) {
    return NextResponse.json(
      { error: "content_ids must be a non-empty array of UUIDs" },
      { status: 400 },
    );
  }

  const result = await notifyTitleRequesters({
    titleId: title_id,
    contentType: contentType as ContentType,
    contentIds,
  });

  // Manual /notify call is an explicit "send these now" intent —
  // hot-path drain rather than waiting for cron's 5-min cadence.
  if (result.enqueuedIds.length > 0) {
    after(async () => {
      try {
        await drainQueue({ ids: result.enqueuedIds, budgetMs: 25_000 });
      } catch (err) {
        console.error("after() drainQueue failed (notify)", err);
      }
    });
  }

  return NextResponse.json(result);
}
