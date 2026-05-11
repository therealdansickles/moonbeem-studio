"use client";

// Granular consent modal. Opens from the banner's Customize button
// AND (future) from a privacy-settings footer link after the banner
// is dismissed.
//
// Two toggles:
//   - Analytics (GA4)
//   - Session recording (Microsoft Clarity)
//
// Save persists the toggles as-is. Reject all persists both off.
// Close-outside / Escape closes the modal without saving (the
// underlying consent state is unchanged; banner re-renders on
// !hasDecided).
//
// Visual treatment (Gate 5): backdrop fades in; dialog scales from
// 0.96 → 1 with opacity 0 → 1 over ~220ms, ease-out — same cadence
// as the consent banner and FanEditModal.

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { useConsent } from "./ConsentProvider";

export default function ConsentSettingsModal() {
  const { state, closeSettings, setConsent, rejectAll } = useConsent();
  // Local draft so user can flip toggles and either Save or close
  // without saving. Seeded from current persisted state.
  const [analytics, setAnalytics] = useState(state.analytics);
  const [sessionRecording, setSessionRecording] = useState(
    state.session_recording,
  );

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") closeSettings();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [closeSettings]);

  function onSave() {
    setConsent({ analytics, session_recording: sessionRecording });
    closeSettings();
  }
  function onRejectAll() {
    rejectAll();
    closeSettings();
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="consent-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) closeSettings();
      }}
    >
      {/* Backdrop (separate motion node so it can fade independently). */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.18, ease: "easeOut" }}
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        aria-hidden="true"
        onClick={closeSettings}
      />

      {/* Dialog */}
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 8 }}
        transition={{ duration: 0.22, ease: "easeOut" }}
        className="relative w-full max-w-md rounded-2xl border border-white/10 bg-moonbeem-black p-6 shadow-2xl"
      >
        <div className="flex items-start justify-between gap-3">
          <h2
            id="consent-modal-title"
            className="m-0 font-wordmark text-heading-md text-moonbeem-pink"
          >
            Privacy settings
          </h2>
          <button
            type="button"
            onClick={closeSettings}
            aria-label="Close"
            className="rounded-md border border-white/10 px-2 py-1 text-caption text-moonbeem-ink-muted hover:border-moonbeem-pink hover:text-moonbeem-pink"
          >
            ✕
          </button>
        </div>

        <p className="mt-3 text-caption text-moonbeem-ink-muted">
          Pick what&apos;s comfortable. You can change this later.
        </p>

        <div className="mt-6 flex flex-col gap-4">
          <ToggleRow
            id="consent-analytics"
            title="Analytics"
            description="Aggregate pageviews and event counts (Google Analytics 4). Helps us understand which surfaces work."
            checked={analytics}
            onChange={setAnalytics}
          />
          <ToggleRow
            id="consent-session-recording"
            title="Session recording"
            description="Anonymous screen recording of how you interact with the site (Microsoft Clarity). Helps us spot UX issues."
            checked={sessionRecording}
            onChange={setSessionRecording}
          />
        </div>

        <div className="mt-8 flex flex-wrap items-center justify-between gap-3">
          <button
            type="button"
            onClick={onRejectAll}
            className="min-h-11 rounded-md border border-white/15 px-3 py-2 text-caption text-moonbeem-ink-muted transition-colors hover:border-moonbeem-pink hover:text-moonbeem-pink"
          >
            Reject all
          </button>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={closeSettings}
              className="min-h-11 rounded-md border border-white/10 px-4 py-2 text-body-sm text-moonbeem-ink-muted transition-colors hover:border-moonbeem-pink hover:text-moonbeem-pink"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onSave}
              style={{ boxShadow: "inset 0 1px 0 rgba(255,255,255,0.22)" }}
              className="min-h-11 rounded-md bg-moonbeem-pink px-5 py-2.5 text-body-sm font-semibold text-moonbeem-navy transition-opacity hover:opacity-90"
            >
              Save
            </button>
          </div>
        </div>
      </motion.div>
    </div>
  );
}

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
      className="flex cursor-pointer items-start justify-between gap-4 rounded-lg border border-white/10 bg-white/[0.02] p-3 transition-colors hover:border-white/15"
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
