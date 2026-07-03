// PATCH /api/admin/source-accounts/[id] — pause / reactivate a source account.
//
// Super-admin only, same 3-line gate. Flips ONLY the `active` flag (load-then-404
// first). Pausing never touches cursor_max_taken_at or last_scraped_at, so a
// reactivated account resumes incrementally from its stored cursor; the roster is
// permanent history (no delete). Coexists with [id]/scrape (POST) — different path.

import { NextResponse, type NextRequest } from "next/server";
import { requireSuperAdmin } from "@/lib/dal";
import { enforce } from "@/lib/ratelimit";
import { createServiceRoleClient } from "@/lib/supabase/service";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireSuperAdmin();
  const rl = await enforce("admin", session.userId, "admin/source-accounts/toggle");
  if (!rl.ok) return rl.response;
  const { id } = await params;

  let body: { active?: unknown } = {};
  try {
    body = (await request.json()) as { active?: unknown };
  } catch {
    // empty body -> active_boolean_required below
  }
  if (typeof body.active !== "boolean") {
    return NextResponse.json({ error: "active_boolean_required" }, { status: 400 });
  }

  const supabase = createServiceRoleClient();
  const { data: existing, error: loadErr } = await supabase
    .from("source_accounts")
    .select("id")
    .eq("id", id)
    .maybeSingle();
  if (loadErr) return NextResponse.json({ error: loadErr.message }, { status: 500 });
  if (!existing) {
    return NextResponse.json({ error: "account_not_found" }, { status: 404 });
  }

  const { data, error } = await supabase
    .from("source_accounts")
    .update({ active: body.active })
    .eq("id", id)
    .select("id, active")
    .single();
  if (error) {
    return NextResponse.json(
      { error: "toggle_failed", detail: error.message },
      { status: 500 },
    );
  }
  return NextResponse.json({ account: data });
}
