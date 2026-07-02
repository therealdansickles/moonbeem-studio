// POST /api/admin/source-accounts/matches/[matchId]/reject
//
// Marks one (post, title) match rejected. No catalog write. Super-admin only.

import { NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/dal";
import { enforce } from "@/lib/ratelimit";
import { createServiceRoleClient } from "@/lib/supabase/service";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ matchId: string }> },
) {
  const session = await requireSuperAdmin();
  const rl = await enforce("admin", session.userId, "admin/source-accounts/reject");
  if (!rl.ok) return rl.response;
  const { matchId } = await params;
  const supabase = createServiceRoleClient();

  const { data: match, error: mErr } = await supabase
    .from("source_account_post_matches")
    .select("id")
    .eq("id", matchId)
    .maybeSingle();
  if (mErr) return NextResponse.json({ error: mErr.message }, { status: 500 });
  if (!match) return NextResponse.json({ error: "match_not_found" }, { status: 404 });

  const { error: updErr } = await supabase
    .from("source_account_post_matches")
    .update({ status: "rejected" })
    .eq("id", matchId);
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
