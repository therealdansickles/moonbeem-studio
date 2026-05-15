// GET /api/admin/creators/search?q=<query>&limit=<n>
//
// Autocomplete for the admin fan-edit attribution override picker.
// Matches on moonbeem_handle or display_name (case-insensitive).
// Super-admin only, rate limited. Min query length 1 — handle list
// is small enough (~100s) that even single-letter prefixes are cheap.

import { NextResponse, type NextRequest } from "next/server";
import { requireSuperAdmin } from "@/lib/dal";
import { enforce } from "@/lib/ratelimit";
import { createServiceRoleClient } from "@/lib/supabase/service";

const MIN_QUERY_LEN = 1;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;

export async function GET(request: NextRequest) {
  const session = await requireSuperAdmin();
  const rl = await enforce("admin", session.userId, "admin/creators/search");
  if (!rl.ok) return rl.response;

  const q = (request.nextUrl.searchParams.get("q") ?? "").trim();
  if (q.length < MIN_QUERY_LEN) {
    return NextResponse.json({ results: [] });
  }
  const limitParam = Number(
    request.nextUrl.searchParams.get("limit") ?? DEFAULT_LIMIT,
  );
  const limit = Number.isFinite(limitParam)
    ? Math.min(Math.max(1, limitParam), MAX_LIMIT)
    : DEFAULT_LIMIT;

  const sb = createServiceRoleClient();
  const like = `%${q.replace(/[%_]/g, "\\$&")}%`;
  const { data, error } = await sb
    .from("creators")
    .select("id, moonbeem_handle, display_name, avatar_url, user_id")
    .or(`moonbeem_handle.ilike.${like},display_name.ilike.${like}`)
    .limit(limit);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ results: data ?? [] });
}
