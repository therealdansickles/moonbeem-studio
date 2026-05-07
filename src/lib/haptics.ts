// Lightweight haptic feedback helper. navigator.vibrate is supported
// on Android Chrome/Edge/Firefox. iOS Safari does NOT expose haptics
// to web JS, so this is effectively a no-op there. The feature check
// makes the call safe in any environment (SSR, iOS, older browsers).

export function vibrate(durationMs: number): void {
  if (typeof navigator === "undefined") return;
  const vib = (navigator as Navigator & { vibrate?: (d: number) => boolean })
    .vibrate;
  if (typeof vib === "function") {
    try {
      vib.call(navigator, durationMs);
    } catch {
      // Some browsers throw when the page hasn't yet had user
      // interaction. Silent — haptic is decorative, not load-bearing.
    }
  }
}
