// Phase 2D — Letterboxd import PUBLISH. Flips this creator's private imported
// ratings/diary/lists public, recomputes affected title aggregates, and merges
// the imported watchlist into the native one — all in one creator-scoped,
// idempotent RPC. Synchronous (no job-status machinery; the RPC is idempotent
// and creator-scoped, so a double-submit just re-runs to a no-op).

import { NextResponse, type NextRequest } from "next/server";
import { requireCreatorForImport } from "@/lib/letterboxd/server";
import { createServiceRoleClient } from "@/lib/supabase/service";

// Generous ceiling for the RPC + the guard query (the RPC itself is bound by
// service_role's ~8s statement_timeout). 60 is valid on every Vercel plan
// (see the import route's note).
export const maxDuration = 60;

export async function POST(_request: NextRequest) {
  // Identical gating chain to apply (auth → userWrites rate limit →
  // import_letterboxd capability → resolved creator).
  const gate = await requireCreatorForImport("me/letterboxd/publish");
  if ("error" in gate) return gate.error;
  const { userId, creatorId } = gate;

  const sb = createServiceRoleClient();

  // Must have actually imported something first.
  const { count } = await sb
    .from("letterboxd_import_jobs")
    .select("id", { head: true, count: "exact" })
    .eq("user_id", userId)
    .eq("status", "completed");
  if (!count) {
    return NextResponse.json({ error: "nothing_to_publish" }, { status: 409 });
  }

  try {
    const { data: published, error } = await sb.rpc("publish_letterboxd_import", {
      p_creator_id: creatorId,
    });
    if (error) throw new Error(error.message);
    return NextResponse.json({ ok: true, published });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
