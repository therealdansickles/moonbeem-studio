"use client";

// First-sign-in welcome banner on /me. The server decides whether to
// render it (zero verified socials AND zero Top 12 picks AND no prior
// dismissal); this component owns the dismiss interactions.
//
// All three exits write users.onboarding_banner_dismissed_at via
// /api/me/onboarding-banner/dismiss:
//   - × button: writes, then fades the banner out in place
//   - "Pick films": writes, then routes to /me/top-12
//   - "Verify a handle": writes, then routes to /me/edit
//
// The natural trigger conditions (picking a film, verifying a social)
// would hide the banner on the next /me load anyway — writing the
// column on CTA click is the belt-and-suspenders so a user who clicks
// through but bounces still doesn't see the banner again.

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function WelcomeBanner({ handle }: { handle: string }) {
  const router = useRouter();
  const [closing, setClosing] = useState(false);
  const [gone, setGone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function writeDismissal() {
    try {
      await fetch("/api/me/onboarding-banner/dismiss", { method: "POST" });
    } catch {
      // Swallow — the banner's trigger conditions are a backstop, and
      // a failed dismissal write at worst shows the banner once more.
    }
  }

  async function handleClose() {
    if (busy) return;
    setBusy(true);
    setClosing(true);
    await writeDismissal();
    setTimeout(() => setGone(true), 200);
  }

  async function handleCta(target: string) {
    if (busy) return;
    setBusy(true);
    await writeDismissal();
    router.push(target);
  }

  if (gone) return null;

  return (
    <div
      className={`relative overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-br from-moonbeem-pink/[0.07] via-white/[0.03] to-transparent p-6 transition-opacity duration-200 ${
        closing ? "opacity-0" : "opacity-100"
      }`}
    >
      <button
        type="button"
        onClick={handleClose}
        disabled={busy}
        aria-label="Dismiss welcome"
        className="absolute right-3 top-3 flex h-7 w-7 items-center justify-center rounded-full text-body-sm text-moonbeem-ink-subtle transition-colors hover:bg-white/10 hover:text-moonbeem-ink disabled:opacity-50"
      >
        ×
      </button>

      <h2 className="font-wordmark text-heading-md text-moonbeem-ink m-0">
        Welcome, @{handle}.
      </h2>
      <p className="mt-1 text-body-sm text-moonbeem-ink-muted">
        Pick a starting point:
      </p>

      <div className="mt-5 flex flex-col gap-5 sm:flex-row sm:gap-6">
        <div className="flex flex-1 flex-col gap-2">
          <p className="text-body font-medium text-moonbeem-ink m-0">
            Curate your top 12
          </p>
          <p className="text-body-sm text-moonbeem-ink-muted m-0">
            Pick films you love. They&apos;ll show on your profile.
          </p>
          <button
            type="button"
            onClick={() => handleCta("/me/top-12")}
            disabled={busy}
            className="mt-1 w-full rounded-md bg-moonbeem-pink px-4 py-2 text-body-sm font-semibold text-moonbeem-navy transition-opacity hover:opacity-90 disabled:opacity-50 sm:w-auto sm:self-start"
          >
            Pick films →
          </button>
        </div>

        <div className="flex flex-1 flex-col gap-2">
          <p className="text-body font-medium text-moonbeem-ink m-0">
            Verify a social handle
          </p>
          <p className="text-body-sm text-moonbeem-ink-muted m-0">
            Already make fan edits on TikTok, IG, or X? Claim them.
          </p>
          <button
            type="button"
            onClick={() => handleCta("/me/edit")}
            disabled={busy}
            className="mt-1 w-full rounded-md border border-white/20 px-4 py-2 text-body-sm font-medium text-moonbeem-ink transition-colors hover:border-moonbeem-pink hover:text-moonbeem-pink disabled:opacity-50 sm:w-auto sm:self-start"
          >
            Verify a handle →
          </button>
        </div>
      </div>

      <p className="mt-5 text-body-sm text-moonbeem-ink-subtle m-0">
        Or browse for a while first. Moonbeem isn&apos;t going anywhere.
      </p>
    </div>
  );
}
