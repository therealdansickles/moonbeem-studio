// verifyApiToken — the Bearer validation core for creator-scoped API
// tokens (the future Premiere panel's auth). PER-ROUTE helper, parallel
// and additive to verifySession; it does NOT touch the cookie/session
// path and is NOT wired into middleware.
//
// A token-authed request resolves to the SAME creator identity a cookie
// session would: it produces a trusted userId from the token row, then
// reuses the identical own-creator lookup the session routes use
// (creators WHERE user_id = ? AND deleted_at IS NULL — see
// src/app/api/me/fan-edits/single/route.ts:69-81 and
// src/app/api/me/socials/route.ts:21-26).
//
// MONEY BOUNDARY: this module imports ONLY the api_tokens table, the
// creators read, the service-role client, the rate-limiter, and the
// token crypto util. It imports NO earnings / metering / withdraw /
// campaign-billing / stripe code. Scopes are content-only; a token is
// structurally incapable of authorizing a money action.

import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { enforce } from "@/lib/ratelimit";
import { constantTimeEqual, hashApiToken } from "./crypto";

// Mirrors verifySession's output contract (userId) so a route can do:
//   const auth = (await verifyApiToken(request)) ?? (await verifySession());
// plus the token-specific creatorId + scopes a panel route needs.
export type ApiTokenAuth = {
  userId: string;
  creatorId: string;
  scopes: string[];
  tokenId: string;
};

// Pull a Bearer token out of the Authorization header. Returns null for
// an absent or malformed header (so dual-auth routes fall through to the
// session, and token-only routes 401).
function extractBearer(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

// Authenticate a request by Bearer API token. Returns the resolved
// creator identity on success, or null for ANY failure mode (absent /
// malformed / unknown / revoked / expired / rate-limited / no creator).
// Never throws on bad input; never logs the raw token.
export async function verifyApiToken(
  request: Request,
): Promise<ApiTokenAuth | null> {
  const token = extractBearer(request);
  if (!token) return null;

  const hash = await hashApiToken(token);

  const supabase = createServiceRoleClient();
  const { data: row, error } = await supabase
    .from("api_tokens")
    .select("id, user_id, token_hash, scopes, revoked_at, expires_at, last_used_at")
    .eq("token_hash", hash)
    .maybeSingle();
  if (error || !row) return null;

  // Constant-time re-check of the hash (belt-and-suspenders over the
  // indexed equality lookup; reject on any ambiguity).
  if (!constantTimeEqual(row.token_hash as string, hash)) return null;

  // Revocation + expiry are checked on EVERY validation.
  if (row.revoked_at) return null;
  if (row.expires_at && Date.parse(row.expires_at as string) <= Date.now()) {
    return null;
  }

  const userId = row.user_id as string;

  // Per-token rate limit, keyed on the owning user. Reuses the shared
  // limiter (fail-open on Upstash outage). Reject when over the limit so
  // a token can't be used to hammer downstream content routes. (Consumer
  // routes added in a later stage may additionally limit by IP.)
  const rl = await enforce("userWrites", `apitoken:${userId}`, "api-token/verify");
  if (!rl.ok) return null;

  // Resolve the creator EXACTLY as the session path does. A token user
  // with no (live) creator cannot act — reject.
  const { data: creator } = await supabase
    .from("creators")
    .select("id")
    .eq("user_id", userId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!creator?.id) return null;

  // Best-effort last_used_at touch, throttled to <=1/min and fired
  // without blocking the response. Failures are swallowed (visibility
  // nicety, not correctness). The raw token is never referenced here.
  const lastUsed = row.last_used_at as string | null;
  const due = !lastUsed || Date.now() - Date.parse(lastUsed) > 60_000;
  if (due) {
    void (async () => {
      try {
        await supabase
          .from("api_tokens")
          .update({ last_used_at: new Date().toISOString() })
          .eq("id", row.id as string);
      } catch {
        // swallow — last_used_at is best-effort
      }
    })();
  }

  return {
    userId,
    creatorId: creator.id as string,
    scopes: (row.scopes as string[] | null) ?? [],
    tokenId: row.id as string,
  };
}

// Authorization step the ROUTE performs after authentication. Returns a
// 403 response when the token lacks the required scope, else null (proceed).
//   const denied = requireScope(auth, "clip:download");
//   if (denied) return denied;
export function requireScope(
  auth: ApiTokenAuth,
  scope: string,
): NextResponse | null {
  if (auth.scopes.includes(scope)) return null;
  return NextResponse.json(
    { error: "insufficient_scope", required: scope },
    { status: 403 },
  );
}
