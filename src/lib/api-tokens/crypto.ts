// Creator API-token crypto primitives. New util — the codebase had no
// SHA-256/hashing before this; generation reuses the house Web Crypto
// idiom (crypto.getRandomValues, as in affiliate-codes.ts and
// socials/handle.ts) widened to a real ~256-bit credential.
//
// SECURITY: the raw token is a secret. NOTHING in this file logs it,
// stores it, or returns it except as the explicit return value of
// generateApiToken(). Callers must surface the raw token to the user
// exactly once and persist ONLY its hash (hashApiToken).

// Recognizable, greppable prefix (à la GitHub's `ghp_`) so the token is
// identifiable in a list and catchable by secret scanners.
export const API_TOKEN_PREFIX = "mbk_live_";

// Content-only scope vocabulary. There is deliberately NO money scope:
// a token is structurally incapable of authorizing a payout/earnings
// action. The DB mirrors this with a CHECK constraint.
export const CONTENT_SCOPES = ["clip:download", "clip:list", "fan_edit:submit"] as const;
export type ApiTokenScope = (typeof CONTENT_SCOPES)[number];

export function isContentScope(s: string): s is ApiTokenScope {
  return (CONTENT_SCOPES as readonly string[]).includes(s);
}

// base64url-encode raw bytes WITHOUT modulo reduction (so there is no
// alphabet bias — unlike the human-typeable short codes in
// affiliate-codes.ts, an API credential wants the full entropy of the
// random bytes). Portable across Node 18+ and Edge (btoa is global).
function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export type GeneratedApiToken = {
  // The raw secret — return to the caller exactly once, never persist.
  token: string;
  // Display-only: "mbk_live_…<last4>". Safe to store and show in a list.
  displayPrefix: string;
};

// Generate a high-entropy token: 32 random bytes (256 bits) base64url-
// encoded, prefixed with mbk_live_. The display prefix keeps the brand
// prefix plus the last 4 chars so a creator can recognize a token in a
// list without the secret ever being shown again.
export function generateApiToken(): GeneratedApiToken {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const token = API_TOKEN_PREFIX + base64url(bytes);
  const displayPrefix = `${API_TOKEN_PREFIX}…${token.slice(-4)}`;
  return { token, displayPrefix };
}

// SHA-256(token) → lowercase hex. Web Crypto subtle.digest — global in
// Node 18+ and Edge, matching the house crypto idiom (no node:crypto
// import). The stored credential is ALWAYS this hash, never the raw token.
export async function hashApiToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

// Constant-time string comparison (no early-exit on the first differing
// char). Length inequality is revealed — unavoidable for strings and not
// secret here (both operands are fixed-length 64-char SHA-256 hex). Used
// as a final re-check after the indexed hash lookup.
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
