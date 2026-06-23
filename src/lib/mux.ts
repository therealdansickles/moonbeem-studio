// Server-side Mux client. Singleton — re-uses one instance across requests so
// the underlying http agent's keep-alive is effective. Reads MUX_TOKEN_ID and
// MUX_TOKEN_SECRET at first use, throws if either is missing. Mirrors
// getStripe() in src/lib/stripe/server.ts.
//
// Scope: API credentials only — enough to create direct uploads, read assets,
// and verify webhook signatures. JWT signing keys for signed/DRM PLAYBACK tokens
// are deliberately NOT on this client; the playback signer is a SEPARATE client
// (getMuxSigner, below), so the ingest client carries no key it doesn't need.

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

let cachedSigner: Mux | null = null;

// Playback/DRM token-signing client. Built ONLY with the signing keypair — NO
// API credentials. JWT signing is local crypto (no api.mux.com call), so this
// client needs no tokenId/tokenSecret; keeping it separate from getMux() means
// neither client carries a credential it doesn't need.
//
// The keys are passed EXPLICITLY because the SDK's auto-load env names
// (MUX_SIGNING_KEY / MUX_PRIVATE_KEY) differ from ours — a zero-arg `new Mux()`
// would NOT pick up our vars:
//   jwtSigningKey  <- MUX_SIGNING_KEY_ID       (the signing key's id)
//   jwtPrivateKey  <- MUX_SIGNING_PRIVATE_KEY  (the base64 RSA private key body)
export function getMuxSigner(): Mux {
  if (cachedSigner) return cachedSigner;
  const jwtSigningKey = process.env.MUX_SIGNING_KEY_ID;
  const jwtPrivateKey = process.env.MUX_SIGNING_PRIVATE_KEY;
  if (!jwtSigningKey || !jwtPrivateKey) {
    throw new Error(
      "MUX_SIGNING_KEY_ID and MUX_SIGNING_PRIVATE_KEY must be set",
    );
  }
  cachedSigner = new Mux({ jwtSigningKey, jwtPrivateKey });
  return cachedSigner;
}
