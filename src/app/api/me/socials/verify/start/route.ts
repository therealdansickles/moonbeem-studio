// Starts a bio-code verification: generates the code, writes it
// to the (platform, handle) creator_socials row via the
// start_social_verification RPC. The RPC uses auth.uid() and
// requires the caller to already have a creator (i.e. claimed a
// moonbeem_handle).

import { NextResponse, type NextRequest } from "next/server";
import { verifySession } from "@/lib/dal";
import { enforce } from "@/lib/ratelimit";
import { createClient } from "@/lib/supabase/server";
import {
  generateVerificationCode,
  isSocialPlatform,
  normalizeHandle,
} from "@/lib/socials/handle";

export async function POST(request: NextRequest) {
  const session = await verifySession();
  const limit = await enforce("userWrites", session.userId, "me/socials/verify/start");
  if (!limit.ok) return limit.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const platform = (body as Record<string, unknown>).platform;
  if (!isSocialPlatform(platform)) {
    return NextResponse.json({ error: "invalid_platform" }, { status: 400 });
  }
  const handle = normalizeHandle((body as Record<string, unknown>).handle);
  if (!handle) {
    return NextResponse.json({ error: "invalid_handle" }, { status: 400 });
  }

  const code = generateVerificationCode();

  // Use the user-cookie client so auth.uid() inside the SECURITY
  // DEFINER RPC resolves to this caller.
  const supabase = await createClient();
  const { error } = await supabase.rpc("start_social_verification", {
    p_platform: platform,
    p_handle: handle,
    p_code: code,
  });
  if (error) {
    // Surface the RPC's exception message ("no_creator",
    // "invalid_handle", etc.) so the UI can render a useful hint.
    const status = error.message === "no_creator" ? 409 : 400;
    return NextResponse.json({ error: error.message }, { status });
  }

  return NextResponse.json({
    verification_code: code,
    platform,
    handle,
  });
}
