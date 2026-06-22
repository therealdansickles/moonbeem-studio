// Server-side Mux client. Singleton — re-uses one instance across requests so
// the underlying http agent's keep-alive is effective. Reads MUX_TOKEN_ID and
// MUX_TOKEN_SECRET at first use, throws if either is missing. Mirrors
// getStripe() in src/lib/stripe/server.ts.
//
// Scope: API credentials only — enough to create direct uploads, read assets,
// and verify webhook signatures. JWT signing keys for signed/DRM PLAYBACK tokens
// are deliberately NOT configured here; that is the playback unit (a later
// commit), and keeping it out means this client carries no key it doesn't need.

import Mux from "@mux/mux-node";

let cached: Mux | null = null;

export function getMux(): Mux {
  if (cached) return cached;
  const tokenId = process.env.MUX_TOKEN_ID;
  const tokenSecret = process.env.MUX_TOKEN_SECRET;
  if (!tokenId || !tokenSecret) {
    throw new Error("MUX_TOKEN_ID and MUX_TOKEN_SECRET must be set");
  }
  cached = new Mux({ tokenId, tokenSecret });
  return cached;
}
