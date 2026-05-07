// Checks whether the user has added the verification_code to the
// platform bio for (platform, handle). On match: calls the
// mark_social_verified_and_merge RPC which atomically marks the
// row verified and merges any stub creator's fan_edits + socials
// into the caller's creator.
//
// Service-role read of the verification_code is intentional —
// creator_socials has RLS with no SELECT policies, and the API is
// the trusted boundary. The code is never returned to the client;
// the response is just verified true/false + an error category.

import { NextResponse, type NextRequest } from "next/server";
import { verifySession } from "@/lib/dal";
import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { BioFetchError, fetchBio } from "@/lib/ensembledata/bio";
import {
  isSocialPlatform,
  normalizeHandle,
  type SocialPlatform,
} from "@/lib/socials/handle";

const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

export async function POST(request: NextRequest) {
  await verifySession();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const platform = (body as Record<string, unknown>)?.platform;
  if (!isSocialPlatform(platform)) {
    return NextResponse.json({ error: "invalid_platform" }, { status: 400 });
  }
  const handle = normalizeHandle((body as Record<string, unknown>)?.handle);
  if (!handle) {
    return NextResponse.json({ error: "invalid_handle" }, { status: 400 });
  }

  // 1. Read the active code via service role (RLS bypass).
  const service = createServiceRoleClient();
  const { data: row, error: readErr } = await service
    .from("creator_socials")
    .select("verification_code, verification_started_at")
    .eq("platform", platform)
    .ilike("handle", handle)
    .maybeSingle();
  if (readErr) {
    return NextResponse.json({ error: readErr.message }, { status: 500 });
  }
  if (!row || !row.verification_code) {
    return NextResponse.json({
      verified: false,
      error: "no_active_verification",
    });
  }
  const startedAt = row.verification_started_at
    ? new Date(row.verification_started_at as string).getTime()
    : 0;
  if (!startedAt || startedAt < Date.now() - VERIFICATION_TTL_MS) {
    return NextResponse.json({
      verified: false,
      error: "verification_expired",
    });
  }
  const code = row.verification_code as string;

  // 2. Fetch the live bio.
  let bio: string;
  try {
    bio = await fetchBio(platform as SocialPlatform, handle);
  } catch (err) {
    if (err instanceof BioFetchError) {
      // Categorized failure — UI maps the code to a friendly string.
      // 200 here (not 502) because the request itself succeeded; the
      // verification just couldn't proceed.
      return NextResponse.json({ verified: false, error: err.code });
    }
    const msg = err instanceof Error ? err.message : "unknown";
    console.error("[bio] unexpected error:", msg);
    return NextResponse.json(
      { verified: false, error: "platform_unavailable" },
    );
  }

  // 3. Substring match (case-insensitive).
  if (!bio.toLowerCase().includes(code.toLowerCase())) {
    return NextResponse.json({
      verified: false,
      error: "code_not_found_in_bio",
    });
  }

  // 4. Atomic verify + stub merge via the user-cookie client so
  //    auth.uid() inside the SECURITY DEFINER RPC is the caller.
  const supabase = await createClient();
  const { data: creatorId, error: mergeErr } = await supabase.rpc(
    "mark_social_verified_and_merge",
    { p_platform: platform, p_handle: handle },
  );
  if (mergeErr) {
    return NextResponse.json(
      { verified: false, error: mergeErr.message },
      { status: 500 },
    );
  }
  return NextResponse.json({ verified: true, creator_id: creatorId });
}
