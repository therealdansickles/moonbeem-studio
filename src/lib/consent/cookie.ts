// Cookie helpers — client-side only (Server Components read via
// next/headers, but the banner provider hydrates on the client and
// writes via document.cookie). Format is JSON of ConsentState.
//
// Cookie attributes: SameSite=Lax (third-party iframes don't need
// it), Secure in production, Path=/, max-age per CONSENT_COOKIE_MAX_AGE.
// No HttpOnly — client needs to read to know whether to show banner.

import {
  CONSENT_COOKIE_MAX_AGE_SECONDS,
  CONSENT_COOKIE_NAME,
  type ConsentState,
} from "./types";

export function readConsentCookie(): ConsentState | null {
  if (typeof document === "undefined") return null;
  const cookies = document.cookie.split(";");
  for (const c of cookies) {
    const [rawName, ...rest] = c.trim().split("=");
    if (rawName !== CONSENT_COOKIE_NAME) continue;
    try {
      const decoded = decodeURIComponent(rest.join("="));
      const parsed = JSON.parse(decoded);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        typeof parsed.analytics === "boolean" &&
        typeof parsed.session_recording === "boolean" &&
        typeof parsed.version === "number" &&
        (parsed.updated_at === null || typeof parsed.updated_at === "string")
      ) {
        return parsed as ConsentState;
      }
    } catch {
      // Malformed cookie — treat as no decision recorded.
      return null;
    }
  }
  return null;
}

export function writeConsentCookie(state: ConsentState): void {
  if (typeof document === "undefined") return;
  const value = encodeURIComponent(JSON.stringify(state));
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie =
    `${CONSENT_COOKIE_NAME}=${value}; ` +
    `Path=/; Max-Age=${CONSENT_COOKIE_MAX_AGE_SECONDS}; ` +
    `SameSite=Lax${secure}`;
}
