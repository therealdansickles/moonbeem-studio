// GET /api/admin/titles/search?q=<query>&limit=<n>
//
// Search across the full ~1.4M-row titles catalog for the partner-
// attribution modal on /admin. Debounced from the UI (300ms typical);
// returns up to LIMIT (default 20) matches ordered by year DESC then
// title ASC.
//
// Backed by the search_titles_admin RPC, which uses
// `lower(title) LIKE lower(query)` so the existing GIN trigram
// index on lower(title) applies. A direct `.ilike("title", ...)`
// from the client bypasses the indexed expression and falls back
// to a parallel seq scan (~26s on the catalog as of 2026-05-09).
//
// Super-admin only. Returns id/slug/title/year + partner_id so the
// UI can warn when a result is already attached.

import { NextResponse, type NextRequest } from "next/server";
import { requireSuperAdmin } from "@/lib/dal";
import { createServiceRoleClient } from "@/lib/supabase/service";

const MIN_QUERY_LEN = 2;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

export async function GET(request: NextRequest) {
  await requireSuperAdmin();

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

  const supabase = createServiceRoleClient();
  const { data, error } = await supabase.rpc("search_titles_admin", {
    query: q,
    max_results: limit,
  });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ results: data ?? [] });
}
