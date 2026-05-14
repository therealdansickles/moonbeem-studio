import { NextResponse, type NextRequest } from "next/server";
import { getCurrentProfile } from "@/lib/dal";
import { createClient } from "@/lib/supabase/server";
import { enforce, getIp } from "@/lib/ratelimit";
import { getUserTier } from "@/lib/gating/get-user-tier";
import { canPerform } from "@/lib/gating/can-perform";
import { logUserEvent } from "@/lib/events/log-event";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: NextRequest) {
  // Gating Phase 2 — save_to_top12 routed through canPerform. Anon
  // is denied with a structured 403 (auth_required) the client turns
  // into a sign-in prompt, replacing the old verifySession redirect.
  const profile = await getCurrentProfile();
  const userId = profile?.userId ?? null;
  const isSuperAdmin = profile?.role === "super_admin";

  const limit = await enforce(
    "userWrites",
    userId ?? getIp(request),
    "profile/top-titles/add",
  );
  if (!limit.ok) return limit.response;

  const tier = await getUserTier(userId);
  const gate = canPerform(tier, "save_to_top12", 0, isSuperAdmin);
  if (!gate.allowed) {
    return NextResponse.json({ error: gate.reason }, { status: 403 });
  }
  // canPerform denies anonymous for save_to_top12, so userId is set.
  const uid = userId as string;

  let body: { title_id?: string; position?: number };
  try {
    body = (await request.json()) as { title_id?: string; position?: number };
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const titleId = (body.title_id ?? "").trim();
  const position = Number(body.position);
  if (!UUID_RE.test(titleId)) {
    return NextResponse.json({ error: "invalid title_id" }, { status: 400 });
  }
  if (!Number.isInteger(position) || position < 1 || position > 12) {
    return NextResponse.json({ error: "invalid position" }, { status: 400 });
  }

  const supabase = await createClient();

  const { data: existing } = await supabase
    .from("user_top_titles")
    .select("id, title_id, position")
    .eq("user_id", uid);

  const taken = new Set((existing ?? []).map((r) => r.position as number));
  const titleIds = new Set((existing ?? []).map((r) => r.title_id as string));

  if (titleIds.has(titleId)) {
    return NextResponse.json(
      { error: "Title already in your Top 12." },
      { status: 409 },
    );
  }

  let finalPosition = position;
  if (taken.has(finalPosition)) {
    let next = -1;
    for (let p = 1; p <= 12; p++) {
      if (!taken.has(p)) {
        next = p;
        break;
      }
    }
    if (next === -1) {
      return NextResponse.json(
        { error: "Top 12 is full." },
        { status: 409 },
      );
    }
    finalPosition = next;
  }

  const { error } = await supabase.from("user_top_titles").insert({
    user_id: uid,
    title_id: titleId,
    position: finalPosition,
  });

  if (error) {
    if (error.code === "23505") {
      return NextResponse.json(
        { error: "Title already in your Top 12." },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  await logUserEvent({
    user_id: uid,
    event_type: "save_to_top12",
    resource_type: "title",
    resource_id: titleId,
    title_id: titleId,
    tier_at_event: tier,
  });

  return NextResponse.json({ success: true, position: finalPosition });
}
