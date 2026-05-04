import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

type RequestType = "fan_edits" | "clips_and_stills";

type Body = {
  title_id?: string;
  redirect_to?: string;
  title_name?: string;
  request_type?: string;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const VALID_REQUEST_TYPES: RequestType[] = ["fan_edits", "clips_and_stills"];

function buildSignInUrl(args: {
  titleId: string;
  redirectTo: string;
  titleName?: string;
  requestType: RequestType;
}): string {
  const params = new URLSearchParams({
    redirect_to: args.redirectTo,
    action: "request_fan_edits",
    title_id: args.titleId,
    request_type: args.requestType,
  });
  if (args.titleName) {
    params.set("title", args.titleName);
  }
  return `/login?${params.toString()}`;
}

export async function POST(request: NextRequest) {
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (!body.title_id || !UUID_RE.test(body.title_id)) {
    return NextResponse.json({ error: "invalid title_id" }, { status: 400 });
  }

  const requestType: RequestType = (() => {
    if (
      typeof body.request_type === "string" &&
      VALID_REQUEST_TYPES.includes(body.request_type as RequestType)
    ) {
      return body.request_type as RequestType;
    }
    if (body.request_type !== undefined) {
      return "__invalid__" as RequestType;
    }
    return "fan_edits";
  })();
  if ((requestType as string) === "__invalid__") {
    return NextResponse.json(
      { error: "request_type must be 'fan_edits' or 'clips_and_stills'" },
      { status: 400 },
    );
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    const redirectTo =
      typeof body.redirect_to === "string" && body.redirect_to.startsWith("/")
        ? body.redirect_to
        : "/";
    return NextResponse.json(
      {
        requires_auth: true,
        redirect_to: buildSignInUrl({
          titleId: body.title_id,
          redirectTo,
          titleName: body.title_name,
          requestType,
        }),
      },
      { status: 401 },
    );
  }

  const { error } = await supabase.from("title_requests").insert({
    title_id: body.title_id,
    user_id: user.id,
    request_type: requestType,
    user_agent: request.headers.get("user-agent")?.slice(0, 500) ?? null,
  });

  if (error) {
    // 23505 = unique violation: already requested. Treat as success (idempotent).
    if (error.code === "23505") {
      return NextResponse.json({ success: true, alreadyRequested: true });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
