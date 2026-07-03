// POST /api/admin/source-accounts — create a source account (roster management v1).
//
// Super-admin only, same 3-line gate as the scrape/confirm/reject routes. Inserts a
// row with handle (trimmed + lowercased, leading @ stripped — the (platform,handle)
// unique index keys on the stored lowercased value) and platform pinned to
// 'instagram' (the only source_account_platform enum value in v1). external_user_id
// is left NULL: the pk resolves lazily on the first scrape. A duplicate (23505) is a
// friendly 409, not a 500. New accounts still need one Backfill to seed the cursor
// before the weekly cron maintains them.

import { NextResponse, type NextRequest } from "next/server";
import { requireSuperAdmin } from "@/lib/dal";
import { enforce } from "@/lib/ratelimit";
import { createServiceRoleClient } from "@/lib/supabase/service";

export async function POST(request: NextRequest) {
  const session = await requireSuperAdmin();
  const rl = await enforce("admin", session.userId, "admin/source-accounts/create");
  if (!rl.ok) return rl.response;

  let body: { handle?: unknown } = {};
  try {
    body = (await request.json()) as { handle?: unknown };
  } catch {
    // empty body -> handle_required below
  }
  const handle =
    typeof body.handle === "string"
      ? body.handle.trim().replace(/^@+/, "").toLowerCase()
      : "";
  if (!handle) {
    return NextResponse.json({ error: "handle_required" }, { status: 400 });
  }
  // v1 pins instagram (the only source_account_platform enum value). The column
  // still carries platform so the composite key + future TikTok are honored.
  const platform = "instagram";

  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from("source_accounts")
    .insert({ platform, handle })
    .select(
      "id, handle, platform, external_user_id, last_scraped_at, cursor_max_taken_at, active",
    )
    .single();
  if (error) {
    if (error.code === "23505") {
      return NextResponse.json(
        { error: "already_in_roster", message: `@${handle} is already in the roster.` },
        { status: 409 },
      );
    }
    return NextResponse.json(
      { error: "create_failed", detail: error.message },
      { status: 500 },
    );
  }
  return NextResponse.json({ account: data });
}
