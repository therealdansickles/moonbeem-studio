// GET /api/me/affiliate/balance
//
// The caller's AFFILIATE earnings balance (held / 14-day-matured) from the
// settlement ledger. Mirrors /api/me/payouts/status exactly: verifySession ->
// resolve the caller's creator SERVER-SIDE -> aggregate via the shared
// getAffiliateBalance helper (the single home of the validity predicate).
//
// Returns ONLY the three aggregates — never raw settlement rows, never another
// creator's data. The creator_id is resolved from the authenticated session, so
// a caller can only ever read their own balance. Read-only; cashing out is
// Layer 3 (no withdraw here).

import { NextResponse } from "next/server";
import { verifySession } from "@/lib/dal";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { enforce } from "@/lib/ratelimit";
import { getAffiliateBalance } from "@/lib/affiliate/balance";

export async function GET() {
  const session = await verifySession();
  const limit = await enforce(
    "userWrites",
    session.userId,
    "me/affiliate/balance",
  );
  if (!limit.ok) return limit.response;

  const supabase = createServiceRoleClient();
  const { data: creator } = await supabase
    .from("creators")
    .select("id")
    .eq("user_id", session.userId)
    .is("deleted_at", null)
    .maybeSingle();
  // Non-creator (or deleted) caller: zeros, mirroring me/payouts/status.
  if (!creator) {
    return NextResponse.json({
      pending_cents: 0,
      available_cents: 0,
      lifetime_cents: 0,
    });
  }

  const balance = await getAffiliateBalance(creator.id as string);
  return NextResponse.json(balance);
}
