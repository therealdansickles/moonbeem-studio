// Global types for the Microsoft Clarity client. Same pattern as
// src/types/gtag.d.ts. The Clarity IIFE in
// src/components/analytics/MicrosoftClarity.tsx attaches `clarity`
// to window. We only call it from the consent-revoke teardown today
// (`window.clarity("stop")`); other commands can be added when needed.

export {};

declare global {
  interface Window {
    clarity?: (...args: unknown[]) => unknown;
  }
}
