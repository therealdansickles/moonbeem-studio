// Shared auth-flow redirect safety. Used by /auth/confirm (post-verify
// destination) and the /login signed-in bounce so the two can't drift.

// The auth entry/wrapper routes must NEVER be a redirect destination. Landing
// back on /auth/callback — especially a BARE one with no ?code — bounces to
// /login?error=auth_failed even though a valid session exists; /auth/confirm and
// /login are collapsed for the same reason. Any resolved destination whose
// pathname is one of these becomes /me.
const AUTH_ROUTES = new Set(["/auth/callback", "/auth/confirm", "/login"]);

export function neutralizeAuthWrapper(dest: string | null): string | null {
  if (!dest) return dest;
  let path: string;
  try {
    path = new URL(dest, "http://internal.invalid").pathname;
  } catch {
    path = dest.split("?")[0].split("#")[0];
  }
  return AUTH_ROUTES.has(path) ? "/me" : dest;
}

// A validated SAME-ORIGIN internal redirect target, or null. Applies
// runPostAuth's safeRedirect rule (must start with "/") PLUS two hardenings the
// safeRedirect rule doesn't need in its own context but a bare redirect() does:
//   - reject protocol-relative targets ("//host", "/\host") — they start with
//     "/" but a browser treats them as cross-origin. runPostAuth is immune
//     because it prefixes the origin (`${origin}${safeRedirect}`); a bare
//     redirect() would honor "//evil.com" as an open redirect.
//   - collapse any auth-wrapper route via neutralizeAuthWrapper.
// Returns null for anything not a safe internal path; the caller falls back to /me.
export function safeInternalRedirect(redirectTo: string | null): string | null {
  if (!redirectTo || !redirectTo.startsWith("/")) return null;
  if (redirectTo.startsWith("//") || redirectTo.startsWith("/\\")) return null;
  return neutralizeAuthWrapper(redirectTo);
}
