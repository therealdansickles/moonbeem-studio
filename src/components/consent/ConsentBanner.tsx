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
//
// Visual treatment (Gate 5):
//   - Accept all is the primary (brand-pink fill, slightly larger
//     padding, subtle inner highlight) — confident, not aggressive.
//   - Reject all + Customize are mutually equal ghost buttons; no
//     visual hint that nudges users toward Accept (no dark pattern).
//   - Framer-motion fade+rise on enter/exit matching the
//     FanEditModal cadence (220ms, ease-out).
//   - Mobile (<md): copy stacks above buttons; Accept all is
//     full-width primary; Reject + Customize sit as a 50/50 row
//     below. iPhone SE (375px) renders the full copy without
//     horizontal scroll.

import { AnimatePresence, motion } from "framer-motion";
import { usePathname } from "next/navigation";
import { useConsent } from "./ConsentProvider";
import ConsentSettingsModal from "./ConsentSettingsModal";

// Mirrors the exclusion lists in GoogleAnalytics + MicrosoftClarity.
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
  const showBanner = isLoaded && !hasDecided && !skipBanner;

  return (
    <>
      <AnimatePresence>
        {showBanner && (
          <motion.div
            key="consent-banner"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            transition={{ duration: 0.22, ease: "easeOut" }}
            role="region"
            aria-label="Cookie consent"
            className="fixed inset-x-0 bottom-0 z-40 border-t border-white/10 bg-moonbeem-black/95 px-4 py-4 backdrop-blur-md shadow-[0_-12px_32px_rgba(0,0,0,0.5)] md:px-6 md:py-5"
          >
            <div className="mx-auto flex max-w-5xl flex-col gap-4 md:flex-row md:items-center md:gap-6">
              <p className="text-body-sm leading-relaxed text-moonbeem-ink-muted md:flex-1">
                Moonbeem uses analytics cookies to understand how the platform
                performs, and session recording (Microsoft Clarity) to spot UX
                issues. You can accept both, accept neither, or pick what&apos;s
                comfortable. We never sell your data.
              </p>

              {/* Mobile layout: Accept all on top as the prominent primary,
                  Customize + Reject all as a 50/50 ghost-pair below. The
                  primary keeps visual prominence (it's the CTA) but the
                  two ghost buttons are mutually equal — no dark pattern
                  steering the eye toward Accept. */}
              <div className="flex flex-col gap-2 md:flex-row md:flex-shrink-0 md:items-center">
                {/* Mobile: ghost pair (renders before the primary visually
                    on mobile via order classes; on desktop the order flips
                    so the primary sits rightmost as natural end-of-flow). */}
                <div className="order-2 grid grid-cols-2 gap-2 md:order-1 md:flex md:gap-2">
                  <button
                    type="button"
                    onClick={openSettings}
                    className="min-h-11 rounded-md border border-white/15 px-4 py-2 text-body-sm text-moonbeem-ink-muted transition-colors hover:border-moonbeem-pink hover:text-moonbeem-pink focus:outline-none focus-visible:ring-2 focus-visible:ring-moonbeem-pink"
                  >
                    Customize
                  </button>
                  <button
                    type="button"
                    onClick={rejectAll}
                    className="min-h-11 rounded-md border border-white/15 px-4 py-2 text-body-sm text-moonbeem-ink-muted transition-colors hover:border-moonbeem-pink hover:text-moonbeem-pink focus:outline-none focus-visible:ring-2 focus-visible:ring-moonbeem-pink"
                  >
                    Reject all
                  </button>
                </div>
                <button
                  type="button"
                  onClick={acceptAll}
                  // Inset white-highlight on top edge for that subtle
                  // 3D-lift "earned presence" that matches the hero
                  // tiles. Padding slightly larger than the ghost pair
                  // so the primary reads first without overpowering.
                  style={{
                    boxShadow: "inset 0 1px 0 rgba(255,255,255,0.22)",
                  }}
                  className="order-1 min-h-11 rounded-md bg-moonbeem-pink px-5 py-2.5 text-body-sm font-semibold text-moonbeem-navy transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-moonbeem-pink md:order-2"
                >
                  Accept all
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      {isSettingsOpen && <ConsentSettingsModal />}
    </>
  );
}
