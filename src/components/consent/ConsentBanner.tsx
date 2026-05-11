"use client";

// Bottom-of-viewport consent banner. Shows when:
//   - Provider has hydrated (isLoaded), AND
//   - User hasn't decided on the current version yet, AND
//   - Current route isn't an admin/api/partner-dashboard surface
//     (these never load GA/Clarity per the analytics components'
//     exclusion lists, so a consent banner there is noise).
//
// Three actions: Accept all / Reject all / Customize (opens the
// ConsentSettingsModal). All three close the banner by writing a
// decided state to the cookie + server.

import { usePathname } from "next/navigation";
import { useConsent } from "./ConsentProvider";
import ConsentSettingsModal from "./ConsentSettingsModal";

// Mirrors the exclusion lists in GoogleAnalytics + MicrosoftClarity.
// Kept in sync by hand; if these surfaces ever start loading
// analytics, the banner-skip here needs to relax too.
const EXCLUDED_PREFIXES = ["/admin", "/api", "/p/"];

function shouldSkipBanner(pathname: string | null): boolean {
  if (!pathname) return false;
  for (const p of EXCLUDED_PREFIXES) {
    if (pathname === p || pathname.startsWith(p)) return true;
  }
  if (pathname === "/p") return true;
  return false;
}

export default function ConsentBanner() {
  const pathname = usePathname();
  const {
    isLoaded,
    hasDecided,
    acceptAll,
    rejectAll,
    openSettings,
    isSettingsOpen,
  } = useConsent();

  const skipBanner = shouldSkipBanner(pathname);

  // Modal can still open post-decision (future footer link) even on
  // excluded surfaces, so we don't suppress it here.
  return (
    <>
      {isLoaded && !hasDecided && !skipBanner && (
        <div
          role="region"
          aria-label="Cookie consent"
          className="fixed inset-x-0 bottom-0 z-40 border-t border-white/10 bg-moonbeem-black/95 px-4 py-4 backdrop-blur-md shadow-[0_-8px_24px_rgba(0,0,0,0.4)] md:px-6"
        >
          <div className="mx-auto flex max-w-5xl flex-col gap-3 md:flex-row md:items-center md:gap-6">
            <p className="text-body-sm text-moonbeem-ink-muted md:flex-1">
              Moonbeem uses analytics cookies to understand how the platform
              performs, and session recording (Microsoft Clarity) to spot UX
              issues. You can accept both, accept neither, or pick what&apos;s
              comfortable. We never sell your data.
            </p>
            <div className="flex flex-col gap-2 md:flex-row md:flex-shrink-0">
              <button
                type="button"
                onClick={openSettings}
                className="rounded-md border border-white/15 px-4 py-2 text-body-sm text-moonbeem-ink-muted hover:border-moonbeem-pink hover:text-moonbeem-pink focus:outline-none focus-visible:ring-2 focus-visible:ring-moonbeem-pink"
              >
                Customize
              </button>
              <button
                type="button"
                onClick={rejectAll}
                className="rounded-md border border-white/15 px-4 py-2 text-body-sm text-moonbeem-ink-muted hover:border-moonbeem-pink hover:text-moonbeem-pink focus:outline-none focus-visible:ring-2 focus-visible:ring-moonbeem-pink"
              >
                Reject all
              </button>
              <button
                type="button"
                onClick={acceptAll}
                className="rounded-md bg-moonbeem-pink px-4 py-2 text-body-sm font-semibold text-moonbeem-navy hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-moonbeem-pink"
              >
                Accept all
              </button>
            </div>
          </div>
        </div>
      )}
      {isSettingsOpen && <ConsentSettingsModal />}
    </>
  );
}
