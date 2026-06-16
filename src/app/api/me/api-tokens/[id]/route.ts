// Revoke a creator API token (soft revoke — sets revoked_at; the row is
// kept for the creator's audit trail). Web-UI-facing, cookie/session-gated.
//
//   PATCH /api/me/api-tokens/[id]  — set revoked_at on the caller's own token.
//
// Creator-scoped by user_id so a caller can NEVER revoke another creator's
// token: the UPDATE matches WHERE id = [id] AND user_id = session.userId, and
// a no-match returns 404. Service-role client (api_tokens is RLS zero-policy).
// Models the socials/visibility PATCH shape. No money code.

import { NextResponse, type NextRequest } from "next/server";
import { verifySession } from "@/lib/dal";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { enforce } from "@/lib/ratelimit";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SAFE_COLUMNS =
  "id, name, token_prefix, scopes, created_at, last_used_at, revoked_at, expires_at";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await verifySession();
  const limit = await enforce("userWrites", session.userId, "me/api-tokens:revoke");
  if (!limit.ok) return limit.response;

  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  const supabase = createServiceRoleClient();
  // Soft revoke, scoped to the caller's own token. Re-revoking just
  // re-stamps revoked_at (idempotent-safe). A row owned by another user
  // (or a nonexistent id) matches nothing → 404.
  const { data: updated, error } = await supabase
    .from("api_tokens")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", id)
    .eq("user_id", session.userId)
    .select(SAFE_COLUMNS)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!updated) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true, api_token: updated });
}
