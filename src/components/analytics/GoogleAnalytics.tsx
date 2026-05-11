"use client";

import Script from "next/script";
import { Suspense, useEffect, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useConsent } from "@/components/consent/ConsentProvider";

// Routes that intentionally don't fire GA. Internal admin tooling
// shouldn't shape product decisions; partner dashboards are not
// public-traffic surfaces. /api shouldn't render this component
// anyway but is excluded as defense.
const EXCLUDED_PREFIXES = ["/admin", "/api", "/p/"];

function shouldSkip(pathname: string): boolean {
  for (const p of EXCLUDED_PREFIXES) {
    if (pathname === p || pathname.startsWith(p)) return true;
  }
  // /p (no trailing slash, exact) is rare but treat as excluded.
  if (pathname === "/p") return true;
  return false;
}

// Inner component wrapped in <Suspense> because useSearchParams
// requires a Suspense boundary in App Router. usePathname does not.
function PageTracker({ gaId }: { gaId: string }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const signinFiredRef = useRef(false);

  // Manual page_view on every pathname change, including first mount.
  // Init script sets send_page_view:false so this is the only path
  // that fires page_view — single source of truth.
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.gtag !== "function") {
      return;
    }
    if (shouldSkip(pathname)) return;
    window.gtag("config", gaId, { page_path: pathname });
  }, [pathname, gaId]);

  // Detect ?signin=1 (appended to the auth/callback redirect URL),
  // fire signin_complete once, then strip the param so subsequent
  // navigations don't refire on back/forward.
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.gtag !== "function") {
      return;
    }
    if (!searchParams) return;
    if (searchParams.get("signin") !== "1") return;
    if (signinFiredRef.current) return;
    signinFiredRef.current = true;
    window.gtag("event", "signin_complete", {});

    const cleanParams = new URLSearchParams(searchParams.toString());
    cleanParams.delete("signin");
    const qs = cleanParams.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [searchParams, pathname, router]);

  return null;
}

// Mounted from the root layout. Renders nothing on excluded routes
// so gtag.js never loads there. On non-excluded routes, loads the
// loader + init scripts and starts the PageTracker for client-side
// route changes.
//
// Consent gate (added 2026-05-11): gtag.js never loads until the
// consent provider has hydrated (isLoaded === true) AND the user's
// state.analytics === true. Pre-hydration the component returns
// null so no script fires during SSR or before the cookie has been
// read on the client. Once the user toggles consent, the component
// re-renders and the Script tag is injected on the page.
//
// Caveat: revoking consent mid-session doesn't tear down the gtag
// global. New consent takes effect on next page navigation/refresh.
// Acceptable per typical consent-banner UX; revisit if compliance
// audit requires hard teardown.
export default function GoogleAnalytics() {
  const gaId = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID;
  const pathname = usePathname();
  const { isLoaded, state } = useConsent();

  if (!gaId) return null; // dev / preview-without-key
  if (shouldSkip(pathname)) return null;
  if (!isLoaded) return null; // consent state unknown — don't fire
  if (!state.analytics) return null;

  return (
    <>
      <Script
        src={`https://www.googletagmanager.com/gtag/js?id=${gaId}`}
        strategy="afterInteractive"
      />
      <Script id="ga-init" strategy="afterInteractive">
        {`
          window.dataLayer = window.dataLayer || [];
          function gtag(){dataLayer.push(arguments);}
          window.gtag = gtag;
          gtag('js', new Date());
          gtag('config', '${gaId}', { send_page_view: false });
        `}
      </Script>
      <Suspense fallback={null}>
        <PageTracker gaId={gaId} />
      </Suspense>
    </>
  );
}
