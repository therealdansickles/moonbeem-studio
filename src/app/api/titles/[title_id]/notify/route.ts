import { NextResponse, type NextRequest } from "next/server";
import {
  notifyTitleRequesters,
  type ContentType,
} from "@/lib/notifications/notify-title-requesters";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const VALID_TYPES: ContentType[] = ["clip", "still", "fan_edit"];

type Body = {
  content_type?: string;
  content_ids?: unknown;
};

export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ title_id: string }> },
) {
  const auth = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY ?? ""}`;
  if (
    !process.env.SUPABASE_SERVICE_ROLE_KEY ||
    auth !== expected
  ) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { title_id } = await ctx.params;
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

  return NextResponse.json(result);
}
