"use client";

import Script from "next/script";
import { usePathname } from "next/navigation";

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
export default function MicrosoftClarity() {
  const projectId = process.env.NEXT_PUBLIC_CLARITY_PROJECT_ID;
  const pathname = usePathname();

  if (!projectId) return null;
  if (shouldSkip(pathname)) return null;

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
