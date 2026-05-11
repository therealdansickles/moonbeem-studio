"use client";

import Script from "next/script";
import { usePathname } from "next/navigation";
import { useConsent } from "@/components/consent/ConsentProvider";

// Same exclusion list as GoogleAnalytics — internal admin and
// partner dashboards shouldn't pollute session-replay data.
// /api never renders this component but is excluded for defense.
const EXCLUDED_PREFIXES = ["/admin", "/api", "/p/"];

function shouldSkip(pathname: string | null): boolean {
  if (!pathname) return false;
  for (const p of EXCLUDED_PREFIXES) {
    if (pathname === p || pathname.startsWith(p)) return true;
  }
  if (pathname === "/p") return true;
  return false;
}

// Microsoft Clarity client snippet. afterInteractive matches the
// GA loader strategy. Returns null on excluded routes so clarity.ms
// never loads there.
//
// Consent gate (added 2026-05-11): clarity.ms IIFE doesn't run until
// the consent provider has hydrated AND state.session_recording is
// true. Pre-hydration the component returns null so no script fires
// during SSR or before the cookie is read.
//
// Caveat: revoking consent mid-session leaves the Clarity global in
// memory. New consent takes effect on next page nav/refresh.
export default function MicrosoftClarity() {
  const projectId = process.env.NEXT_PUBLIC_CLARITY_PROJECT_ID;
  const pathname = usePathname();
  const { isLoaded, state } = useConsent();

  if (!projectId) return null;
  if (shouldSkip(pathname)) return null;
  if (!isLoaded) return null;
  if (!state.session_recording) return null;

  return (
    <Script id="microsoft-clarity" strategy="afterInteractive">
      {`
        (function(c,l,a,r,i,t,y){
          c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};
          t=l.createElement(r);t.async=1;
          t.src="https://www.clarity.ms/tag/"+i;
          y=l.getElementsByTagName(r)[0];
          y.parentNode.insertBefore(t,y);
        })(window, document, "clarity", "script", "${projectId}");
      `}
    </Script>
  );
}
