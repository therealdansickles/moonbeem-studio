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

export function useConsent(): ConsentContextValue {
  const ctx = useContext(ConsentContext);
  if (!ctx) {
    throw new Error("useConsent must be called inside <ConsentProvider>");
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
