// Global types for the Google Analytics 4 gtag.js client.
//
// The script (loaded via next/script in
// src/components/analytics/GoogleAnalytics.tsx) attaches `gtag` and
// `dataLayer` to window. Call sites pull through the typed wrappers
// in src/lib/analytics/track.ts; this declaration just keeps direct
// references type-safe when needed.

export {};

declare global {
  interface Window {
    gtag: (...args: unknown[]) => void;
    dataLayer: unknown[];
  }
}
