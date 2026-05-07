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
    // No apiVersion override — use the SDK's pinned default so the
    // response types stay aligned with what we're calling. Bumping
    // the SDK is the way to move to a newer API version.
    typescript: true,
    appInfo: { name: "moonbeem-studio", version: "1.0" },
  });
  return cached;
}
