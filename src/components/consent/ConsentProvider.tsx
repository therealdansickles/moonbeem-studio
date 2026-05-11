"use client";

// Cookie-consent context + hydration logic. Wraps the public app in
// layout.tsx. Anonymous visitors persist state in the
// mb_consent cookie; signed-in users mirror to users.consent_state
// via /api/me/consent so consent persists cross-device.
//
// Hydration order:
//   1. SSR renders the tree with initialCountry (read from
//      x-vercel-ip-country in layout.tsx). State starts with
//      defaultStateForGeo(isOptIn) and isLoaded=false.
//   2. Client mount reads the cookie. If found, state ← cookie.
//      isLoaded flips true. Banner shows iff !hasDecided(state).
//   3. Auth check (best-effort): if /api/me/consent returns 401,
//      stop. If it returns a non-null consent_state, server wins
//      over cookie (server is source of truth across devices). If
//      cookie had a state but server didn't, push cookie state to
//      server via PUT so this device becomes the seed.
//
// useConsent() throws if called outside the provider — same
// discipline as useFanEditModal.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  CONSENT_VERSION,
  defaultStateForGeo,
  hasDecided,
  type ConsentState,
} from "@/lib/consent/types";
import { readConsentCookie, writeConsentCookie } from "@/lib/consent/cookie";
import { isOptInRegion } from "@/lib/consent/regions";

type ConsentContextValue = {
  state: ConsentState;
  isLoaded: boolean;
  isOptInRegion: boolean;
  // True when the user has interacted with the banner on the current
  // version. Banner consumers use this to decide whether to render.
  hasDecided: boolean;
  // Banner UI calls these. Each writes the cookie + (if signed in)
  // PUTs to /api/me/consent. Server failures are swallowed — client
  // state stays authoritative locally, which is correct UX (a server
  // hiccup shouldn't bounce the user back to the banner).
  acceptAll: () => void;
  rejectAll: () => void;
  setConsent: (next: {
    analytics: boolean;
    session_recording: boolean;
  }) => void;
  // Settings link in the footer (later) calls this to reopen the
  // modal post-decision. Implemented via a boolean the banner
  // component subscribes to.
  openSettings: () => void;
  closeSettings: () => void;
  isSettingsOpen: boolean;
};

const ConsentContext = createContext<ConsentContextValue | null>(null);

// Safe default returned by useConsent when called outside a
// <ConsentProvider>. Models "nothing loaded yet, opt-in region" —
// gated components (GoogleAnalytics, MicrosoftClarity) return null
// at `!isLoaded` so scripts don't fire and the page doesn't crash.
//
// Why return defaults instead of throwing: industry convention for
// consent libraries. A misconfigured mount tree shouldn't crash a
// user's page — it should fail quiet + safe. The console.warn in
// useConsent surfaces the misconfiguration to engineers during dev
// + browser inspection in prod. Discovered the hard way 2026-05-11
// when GA/Clarity were rendered as siblings (not children) of the
// provider and the original throw cascaded into a 500-ing SSR.
const SAFE_DEFAULT_CONSENT: ConsentContextValue = {
  state: {
    analytics: false,
    session_recording: false,
    updated_at: null,
    version: 1,
  },
  isLoaded: false,
  isOptInRegion: true,
  hasDecided: false,
  acceptAll: () => {},
  rejectAll: () => {},
  setConsent: () => {},
  openSettings: () => {},
  closeSettings: () => {},
  isSettingsOpen: false,
};

export function useConsent(): ConsentContextValue {
  const ctx = useContext(ConsentContext);
  if (!ctx) {
    // Outside <ConsentProvider>. Surface a console warning so the
    // misconfiguration is visible during dev + prod debugging,
    // but return SAFE_DEFAULT_CONSENT so the calling component
    // doesn't crash the page.
    if (typeof console !== "undefined") {
      console.warn(
        "useConsent called outside <ConsentProvider> — returning safe default. " +
          "Wrap the calling component inside <ConsentProvider> in app/layout.tsx.",
      );
    }
    return SAFE_DEFAULT_CONSENT;
  }
  return ctx;
}

type Props = {
  // ISO-3166-1 alpha-2 from x-vercel-ip-country. null when the
  // header isn't set (local dev, certain edge cases) — treated as
  // opt-in by isOptInRegion.
  initialCountry: string | null;
  children: ReactNode;
};

export default function ConsentProvider({ initialCountry, children }: Props) {
  const optIn = useMemo(() => isOptInRegion(initialCountry), [initialCountry]);

  // SSR + first-paint state: defaults applied per geo. isLoaded
  // false so consumers can avoid firing tracking before the cookie
  // has been read.
  const [state, setState] = useState<ConsentState>(() =>
    defaultStateForGeo(optIn)
  );
  const [isLoaded, setIsLoaded] = useState(false);
  const [isSettingsOpen, setSettingsOpen] = useState(false);

  // Hard teardown of analytics globals when user revokes consent.
  // The component-level gating in GoogleAnalytics + MicrosoftClarity
  // stops NEW <Script> tags from rendering, but scripts already
  // loaded in the current tab keep beaconing until page reload.
  // This effect signals the SDKs to stop actively tracking the
  // moment consent flips false on a category.
  //
  // - window.clarity("stop") halts Clarity's session-recording
  //   beacon loop. No-op if Clarity never loaded.
  // - gtag('consent','update',{analytics_storage:'denied'}) sets
  //   GA into "consent denied" mode — subsequent gtag calls drop
  //   their analytics payload. No-op if gtag never loaded.
  //
  // Diagnosed 2026-05-11: confirmed in-memory beaconing post-reject
  // via dual-tab test (mb_consent rejected in tab A; tab B opened
  // fresh — Clarity correctly did NOT fire in tab B, but tab A
  // continued beaconing until this teardown was wired).
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!state.session_recording && typeof window.clarity === "function") {
      try {
        window.clarity("stop");
      } catch {
        // Swallow — teardown is best-effort. The component-level
        // gating already prevented new Script injection.
      }
    }
    if (!state.analytics && typeof window.gtag === "function") {
      try {
        window.gtag("consent", "update", {
          analytics_storage: "denied",
          ad_storage: "denied",
        });
      } catch {
        // Same swallow rationale.
      }
    }
  }, [state.analytics, state.session_recording]);

  // Mount: hydrate from cookie, then best-effort fetch server state
  // for signed-in users.
  useEffect(() => {
    const cookie = readConsentCookie();
    if (cookie) {
      setState(cookie);
    }
    setIsLoaded(true);

    // Async server hydration. Anonymous → 401, we ignore. Signed in
    // with stored consent → server wins. Signed in but server has
    // no record → push current cookie state (if present) up so the
    // device becomes the seed.
    (async () => {
      try {
        const res = await fetch("/api/me/consent", { credentials: "include" });
        if (res.status === 401) return; // anonymous, expected
        if (!res.ok) return;
        const json = (await res.json()) as { consent_state: unknown };
        const remote = json.consent_state as ConsentState | null;
        if (remote && hasDecided(remote)) {
          setState(remote);
          writeConsentCookie(remote);
          return;
        }
        // Server has nothing — seed it from cookie if the cookie has
        // a real (post-decision) state.
        if (cookie && hasDecided(cookie)) {
          await fetch("/api/me/consent", {
            method: "PUT",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              analytics: cookie.analytics,
              session_recording: cookie.session_recording,
            }),
          }).catch(() => {});
        }
      } catch {
        // Network hiccup — swallow. Client state stays authoritative.
      }
    })();
  }, []);

  const persist = useCallback(
    async (next: { analytics: boolean; session_recording: boolean }) => {
      const stamped: ConsentState = {
        analytics: next.analytics,
        session_recording: next.session_recording,
        updated_at: new Date().toISOString(),
        version: CONSENT_VERSION,
      };
      setState(stamped);
      writeConsentCookie(stamped);
      // Fire-and-forget server write — 401 (anon) and 5xx both
      // swallowed. Client state is authoritative for UX; server
      // sync is the cross-device mirror.
      fetch("/api/me/consent", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      }).catch(() => {});
    },
    [],
  );

  const acceptAll = useCallback(
    () => persist({ analytics: true, session_recording: true }),
    [persist],
  );
  const rejectAll = useCallback(
    () => persist({ analytics: false, session_recording: false }),
    [persist],
  );
  const setConsent = useCallback(
    (next: { analytics: boolean; session_recording: boolean }) => persist(next),
    [persist],
  );

  const openSettings = useCallback(() => setSettingsOpen(true), []);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  const value = useMemo<ConsentContextValue>(
    () => ({
      state,
      isLoaded,
      isOptInRegion: optIn,
      hasDecided: hasDecided(state),
      acceptAll,
      rejectAll,
      setConsent,
      openSettings,
      closeSettings,
      isSettingsOpen,
    }),
    [
      state,
      isLoaded,
      optIn,
      acceptAll,
      rejectAll,
      setConsent,
      openSettings,
      closeSettings,
      isSettingsOpen,
    ],
  );

  return (
    <ConsentContext.Provider value={value}>{children}</ConsentContext.Provider>
  );
}
