// POST /api/admin/source-accounts/matches/[matchId]/confirm
//
// Confirms one (post, title) match into the catalog: creates a fan_edit for the
// matched title via the shared insertFanEditCandidate path (dedupeScope:'title' so
// a listicle post can attach to several titles), then marks the match confirmed
// and records the resulting fan_edit id. Super-admin only. Idempotent: a
// re-confirm returns the existing fan_edit.

import { NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/dal";
import { enforce } from "@/lib/ratelimit";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { insertFanEditCandidate, type FanEditCandidate } from "@/lib/fan-edits-insert";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ matchId: string }> },
) {
  const session = await requireSuperAdmin();
  const rl = await enforce("admin", session.userId, "admin/source-accounts/confirm");
  if (!rl.ok) return rl.response;
  const { matchId } = await params;
  const supabase = createServiceRoleClient();

  const { data: match, error: mErr } = await supabase
    .from("source_account_post_matches")
    .select("id, matched_title_id, status, source_account_post_id, confirmed_fan_edit_id")
    .eq("id", matchId)
    .maybeSingle();
  if (mErr) return NextResponse.json({ error: mErr.message }, { status: 500 });
  if (!match) return NextResponse.json({ error: "match_not_found" }, { status: 404 });
  if (match.status === "confirmed" && match.confirmed_fan_edit_id) {
    return NextResponse.json({
      ok: true,
      already: true,
      fan_edit_id: match.confirmed_fan_edit_id,
    });
  }

  const { data: post } = await supabase
    .from("source_account_posts")
    .select("post_url, caption, taken_at, video_view_count, like_count, source_account_id")
    .eq("id", match.source_account_post_id)
    .maybeSingle();
  if (!post) return NextResponse.json({ error: "post_not_found" }, { status: 404 });

  const { data: account } = await supabase
    .from("source_accounts")
    .select("handle, platform")
    .eq("id", post.source_account_id)
    .maybeSingle();
  if (!account) return NextResponse.json({ error: "account_not_found" }, { status: 404 });

  const candidate: FanEditCandidate = {
    // v1 source accounts are Instagram-only (source_account_platform enum). When
    // TikTok is added, map account.platform -> the fan_edits platform here.
    platform: "instagram",
    embed_url: post.post_url,
    creator_handle: account.handle,
    caption: post.caption,
    posted_at:
      typeof post.taken_at === "number" && post.taken_at > 0
        ? new Date(post.taken_at * 1000).toISOString()
        : null,
    // view-tracking backfills the IG thumbnail + refreshes counts on its next tick.
    thumbnail_url: null,
    view_count: post.video_view_count,
    like_count: post.like_count,
  };

  const outcome = await insertFanEditCandidate(
    supabase,
    match.matched_title_id,
    candidate,
    { dedupeScope: "title" },
  );
  if (!outcome.ok && outcome.reason !== "duplicate") {
    return NextResponse.json(
      { error: "insert_failed", reason: outcome.reason, detail: outcome.detail },
      { status: 502 },
    );
  }
  const fanEditId = outcome.ok ? outcome.inserted_id : outcome.existing_id;

  const { error: updErr } = await supabase
    .from("source_account_post_matches")
    .update({ status: "confirmed", confirmed_fan_edit_id: fanEditId })
    .eq("id", matchId);
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });

  return NextResponse.json({
    ok: true,
    fan_edit_id: fanEditId,
    duplicate: !outcome.ok,
  });
}
