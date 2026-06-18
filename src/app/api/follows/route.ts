// Follow feature — Step 3: write route. A THIN wrapper over the self-resolving
// Step 2 functions. Policy (rate-limit) lives here; the actor is resolved INSIDE
// followCreator/unfollowCreator from the session. This route passes ONLY the
// client-supplied target_creator_id and never an actor — that asymmetry is the
// structural forged-follow guard.
//
//   POST   /api/follows  { target_creator_id }  → follow
//   DELETE /api/follows  { target_creator_id }  → unfollow

import { NextResponse, type NextRequest } from "next/server";
import { getUser } from "@/lib/dal";
import { enforce } from "@/lib/ratelimit";
import {
  followCreator,
  unfollowCreator,
  type FollowOutcome,
} from "@/lib/follows/server";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Map the FollowOutcome union to HTTP. reason is ALWAYS in the body so the
// client branches on it (success / auth_required → sign-in / no_creator →
// onboarding / everything else → inline error). no_creator stays distinct from
// a generic error — it's a conversion prompt, not a failure.
function outcomeToResponse(outcome: FollowOutcome): NextResponse {
  if (outcome.ok) {
    return NextResponse.json({
      ok: true,
      isFollowing: outcome.isFollowing,
      followerCount: outcome.followerCount,
    });
  }
  const status =
    outcome.reason === "auth_required"
      ? 401
      : outcome.reason === "no_creator"
        ? 403
        : outcome.reason === "self_follow"
          ? 400
          : outcome.reason === "target_not_found"
            ? 404
            : 500;
  return NextResponse.json({ ok: false, reason: outcome.reason }, { status });
}

async function handle(
  request: NextRequest,
  op: "follow" | "unfollow",
): Promise<NextResponse> {
  // Cheap auth gate + a stable rate-limit key BEFORE any DB work. Anon callers
  // never reach the limiter or the DB.
  const user = await getUser();
  if (!user) {
    return NextResponse.json(
      { ok: false, reason: "auth_required" },
      { status: 401 },
    );
  }

  // RATE LIMIT — reuse the established mutation tier (userWrites = 30/min/user).
  // A follow is a cheap, scriptable write on a public graph; this is the cap
  // that blocks scripted mass-follow (count inflation now, notification-spam
  // later). Per-user key, sliding window. enforce() fails open on Upstash
  // outage by design.
  const rl = await enforce("userWrites", user.id, `follows:${op}`);
  if (!rl.ok) return rl.response;

  let body: { target_creator_id?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { ok: false, reason: "error" },
      { status: 400 },
    );
  }
  const target = (body.target_creator_id ?? "").trim();
  if (!UUID_RE.test(target)) {
    return NextResponse.json(
      { ok: false, reason: "target_not_found" },
      { status: 404 },
    );
  }

  // ONLY the target is passed. The actor is resolved inside the function from
  // the session — never threaded from the request.
  const outcome =
    op === "follow"
      ? await followCreator(target)
      : await unfollowCreator(target);
  return outcomeToResponse(outcome);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  return handle(request, "follow");
}

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  return handle(request, "unfollow");
}
