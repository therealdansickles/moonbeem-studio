// Shared types + constants for the consent banner.
//
// Persisted shape (cookie + users.consent_state jsonb) matches the
// server contract in /api/me/consent. version bumps prompt a re-show
// of the banner for users who consented to an older copy version
// (today: version 1).

export const CONSENT_VERSION = 1;
export const CONSENT_COOKIE_NAME = "mb_consent";
// 13 months — GDPR guidance recommends ≤13 months between re-prompts.
export const CONSENT_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 395;

export type ConsentState = {
  analytics: boolean;
  session_recording: boolean;
  // ISO timestamp; null when the user hasn't interacted with the
  // banner yet (initial default by geo). hasDecided() reads this.
  updated_at: string | null;
  version: number;
};

// Defaults applied before the user has interacted with the banner.
// EU/UK/CH: everything off until opt-in. Elsewhere: everything on,
// banner gives user the chance to opt out (CCPA-permissible).
export function defaultStateForGeo(isOptIn: boolean): ConsentState {
  return {
    analytics: !isOptIn,
    session_recording: !isOptIn,
    updated_at: null,
    version: CONSENT_VERSION,
  };
}

// True when the user has interacted with the banner (Accept/Reject/
// Save) on the CURRENT version. Returning false here = banner should
// be shown.
export function hasDecided(state: ConsentState | null): boolean {
  if (!state) return false;
  if (state.updated_at === null) return false;
  if (state.version < CONSENT_VERSION) return false;
  return true;
}
