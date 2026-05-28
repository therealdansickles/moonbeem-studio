// POST /api/me/stubs/[stubId]/claim — claim an orphan stub creator
// surfaced in the "Edits to claim" section on /me. Delegates the
// security gate entirely to the merge_stub_creator RPC
// (20260528000002), which mirrors getUnclaimedStubEditsForUser's
// match heuristics line-by-line. This route just adapts the RPC's
// thrown-exception names into HTTP statuses + error JSON.

import { NextResponse, type NextRequest } from "next/server";
import { verifySession } from "@/lib/dal";
import { createClient } from "@/lib/supabase/server";
import { enforce } from "@/lib/ratelimit";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(
  _request: NextRequest,
  context: { params: Promise<{ stubId: string }> },
) {
  const session = await verifySession();
  const limit = await enforce(
    "userWrites",
    session.userId,
    "me/stubs/claim",
  );
  if (!limit.ok) return limit.response;

  const { stubId } = await context.params;
  if (!UUID_RE.test(stubId)) {
    return NextResponse.json({ error: "invalid_stub_id" }, { status: 400 });
  }

  // Cookie-based client so auth.uid() inside the SECURITY DEFINER RPC
  // resolves to the caller. The RPC enforces the auth + ownership +
  // heuristic-match checks itself; this route stays a thin adapter.
  const supabase = await createClient();
  const { error } = await supabase.rpc("merge_stub_creator", {
    p_stub_creator_id: stubId,
  });

  if (error) {
    const msg = error.message ?? "";
    if (msg.includes("not_authenticated")) {
      return NextResponse.json(
        { error: "Not authenticated." },
        { status: 401 },
      );
    }
    if (msg.includes("no_creator_for_user")) {
      return NextResponse.json(
        { error: "Claim your handle before claiming edits." },
        { status: 409 },
      );
    }
    if (msg.includes("stub_not_claimable")) {
      // Stub was already claimed by another transaction, or doesn't
      // exist, or was soft-deleted. From the caller's perspective
      // this means "the section's view of the world is stale" —
      // a router.refresh() on the client clears it.
      return NextResponse.json(
        { error: "These edits are no longer available to claim." },
        { status: 409 },
      );
    }
    if (msg.includes("no_claim_match")) {
      // Caller has no matching heuristic for this stub. Either the
      // /me surface is showing them a stub they shouldn't see
      // (a query bug worth fixing) or someone is calling the route
      // directly with a stub_id they have no plausible tie to
      // (the gate working as designed).
      return NextResponse.json(
        { error: "You can't claim this stub." },
        { status: 403 },
      );
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
