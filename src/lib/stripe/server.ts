// Server-side Stripe client. Singleton — re-uses the same instance
// across requests so the underlying http agent's keep-alive is
// effective. Reads STRIPE_SECRET_KEY at first use, throws if missing.

import Stripe from "stripe";

let cached: Stripe | null = null;

export function getStripe(): Stripe {
  if (cached) return cached;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error("STRIPE_SECRET_KEY missing");
  }
  cached = new Stripe(key, {
    // Explicitly pinned to the SDK's current default API version. This
    // is a no-op today (it equals what the SDK would use anyway), but it
    // freezes the money path against silent behavior shifts on a future
    // SDK bump. Moving versions is now a deliberate edit here, paired
    // with bumping the SDK so the response types stay aligned.
    apiVersion: "2026-05-27.dahlia",
    typescript: true,
    appInfo: { name: "moonbeem-studio", version: "1.0" },
  });
  return cached;
}
