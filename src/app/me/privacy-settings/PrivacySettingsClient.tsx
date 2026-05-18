"use client";

// Interactive body of /me/privacy-settings. Reads + writes consent
// through useConsent() (provider lives in the root layout).
//
// Unlike ConsentSettingsModal — which keeps a local draft so the
// user can Save or dismiss — a settings page has no "dismiss"
// affordance, so each toggle persists immediately via setConsent().
// That also makes the "Last updated" line move the moment a choice
// changes, which is the behaviour we want here.
//
// While the provider is still hydrating from the cookie (isLoaded
// false), we show a brief loading line so the toggles never render
// against the pre-hydration geo default.

import Link from "next/link";
import { useConsent } from "@/components/consent/ConsentProvider";

export default function PrivacySettingsClient() {
  const { state, isLoaded, setConsent, rejectAll } = useConsent();

  return (
    <div className="min-h-screen px-6 py-12 text-moonbeem-ink">
      <div className="mx-auto flex max-w-2xl flex-col gap-6">
        <header className="flex flex-col gap-2">
          <h1 className="font-wordmark text-display-md text-moonbeem-pink m-0">
            Privacy settings
          </h1>
          <p className="text-body text-moonbeem-ink-muted leading-relaxed m-0">
            Control what Moonbeem measures while you browse. These choices live
            in a cookie on this device — and sync to your account when
            you&apos;re signed in. Change them as often as you like; each
            toggle saves on its own.
          </p>
        </header>

        {!isLoaded ? (
          <p className="text-body-sm text-moonbeem-ink-muted m-0">
            Loading your settings…
          </p>
        ) : (
          <>
            <div className="flex flex-col gap-4">
              <ToggleRow
                id="setting-analytics"
                title="Analytics"
                description="Aggregate pageviews, event counts (Google Analytics 4), and approximate location (country, region, city) derived from your IP. Helps us understand which surfaces work and where our audience is."
                checked={state.analytics}
                onChange={(next) =>
                  setConsent({
                    analytics: next,
                    session_recording: state.session_recording,
                  })
                }
              />
              <ToggleRow
                id="setting-session-recording"
                title="Session recording"
                description="Anonymous screen recording of how you interact with the site (Microsoft Clarity). Helps us spot UX issues."
                checked={state.session_recording}
                onChange={(next) =>
                  setConsent({
                    analytics: state.analytics,
                    session_recording: next,
                  })
                }
              />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3">
              <button
                type="button"
                onClick={rejectAll}
                className="rounded-md border border-white/15 px-3 py-2 text-caption text-moonbeem-ink-muted hover:border-moonbeem-pink hover:text-moonbeem-pink"
              >
                Reject all
              </button>
              <p className="text-caption text-moonbeem-ink-subtle m-0">
                {state.updated_at
                  ? `Last updated ${new Date(state.updated_at).toLocaleString()}`
                  : "Not set yet — using the defaults for your region."}
              </p>
            </div>
          </>
        )}

        <p className="text-caption text-moonbeem-ink-muted leading-relaxed m-0">
          For the full picture of what we collect and why, read our{" "}
          <Link
            className="text-moonbeem-pink hover:opacity-90"
            href="/privacy-policy"
          >
            Privacy Policy
          </Link>{" "}
          and{" "}
          <Link
            className="text-moonbeem-pink hover:opacity-90"
            href="/terms-of-service"
          >
            Terms of Service
          </Link>
          .
        </p>
      </div>
    </div>
  );
}

// Mirrors the ToggleRow in ConsentSettingsModal so the two consent
// surfaces stay visually identical.
function ToggleRow({
  id,
  title,
  description,
  checked,
  onChange,
}: {
  id: string;
  title: string;
  description: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label
      htmlFor={id}
      className="flex cursor-pointer items-start justify-between gap-4 rounded-lg border border-white/10 bg-white/[0.02] p-3"
    >
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-body-sm font-medium text-moonbeem-ink">
          {title}
        </span>
        <span className="mt-1 text-caption text-moonbeem-ink-muted">
          {description}
        </span>
      </div>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1 h-4 w-4 shrink-0 cursor-pointer accent-moonbeem-pink"
      />
    </label>
  );
}
