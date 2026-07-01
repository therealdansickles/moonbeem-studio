import { NextResponse, after, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { enforce, getIp } from "@/lib/ratelimit";
import { sendTitleRequestAlert } from "@/lib/email/title-request-alert";
import { PUBLICLY_READABLE_FAN_EDIT_STATUSES } from "@/lib/fan-edits/status";

type RequestType = "fan_edits" | "clips" | "stills";

type Body = {
  title_id?: string;
  redirect_to?: string;
  title_name?: string;
  request_type?: string;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const VALID_REQUEST_TYPES: RequestType[] = ["fan_edits", "clips", "stills"];

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
  const limit = await enforce("tightAnon", getIp(request), "titles/request");
  if (!limit.ok) return limit.response;

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
      { error: "request_type must be 'fan_edits', 'clips', or 'stills'" },
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

  const { data: existing } = await supabase
    .from("title_requests")
    .select("requested_at")
    .eq("title_id", body.title_id)
    .eq("user_id", user.id)
    .eq("request_type", requestType)
    .maybeSingle();

  if (existing) {
    return NextResponse.json({
      already_requested: true,
      requested_at: existing.requested_at,
    });
  }

  // If the title already has a published fan_edit, a FAN_EDITS request is
  // pre-fulfilled at insert time. clips/stills requests are NOT pre-fulfilled
  // by a fan_edit — they're satisfied only by an actual clip/still upload — so
  // this born-fulfilled check is scoped to request_type='fan_edits'. No
  // notification fires — that's the fan-edit fulfillment hook's job, and this
  // isn't a fan_edit insert. Visibility = the same 3-condition rule the
  // fan_edit display surfaces use.
  let fulfilledAt: string | null = null;
  if (requestType === "fan_edits") {
    const { data: existingFanEdit } = await supabase
      .from("fan_edits")
      .select("id")
      .eq("title_id", body.title_id)
      .eq("is_active", true)
      .in("verification_status", PUBLICLY_READABLE_FAN_EDIT_STATUSES)
      .is("deleted_at", null)
      .limit(1)
      .maybeSingle();
    fulfilledAt = existingFanEdit ? new Date().toISOString() : null;
  }

  const { error } = await supabase.from("title_requests").insert({
    title_id: body.title_id,
    user_id: user.id,
    request_type: requestType,
    user_agent: request.headers.get("user-agent")?.slice(0, 500) ?? null,
    fulfilled_at: fulfilledAt,
  });

  if (error) {
    if (error.code === "23505") {
      // Race: another request inserted between our SELECT and INSERT.
      // Re-fetch so we can return the canonical timestamp.
      const { data: row } = await supabase
        .from("title_requests")
        .select("requested_at")
        .eq("title_id", body.title_id)
        .eq("user_id", user.id)
        .eq("request_type", requestType)
        .maybeSingle();
      return NextResponse.json({
        already_requested: true,
        requested_at: row?.requested_at ?? null,
      });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // New request landed — fire admin alert out-of-band. Fail-soft.
  const titleId = body.title_id;
  const userId = user.id;
  const alertRequestType = requestType;
  after(async () => {
    try {
      const res = await sendTitleRequestAlert({
        titleId,
        requesterUserId: userId,
        requestType: alertRequestType,
      });
      if (!res.ok) {
        console.warn("[title-request-alert] send failed", res.error);
      }
    } catch (err) {
      console.warn("[title-request-alert] send threw", err);
    }
  });

  return NextResponse.json({ success: true });
}
