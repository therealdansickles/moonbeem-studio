// This file configures the initialization of Sentry for edge features (middleware, edge routes, and so on).
// The config you add here will be used whenever one of the edge features is loaded.
// Note that this config is unrelated to the Vercel Edge Runtime and is also required when running locally.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/
//
// Hardening mirrors sentry.server.config.ts via the SAME shared scrubber —
// middleware sees every request (cookies included), so the edge lane gets the
// identical strip/drop rules.

import * as Sentry from "@sentry/nextjs";
import { scrubSentryEvent, tracesSampler } from "./src/lib/sentry/scrub";

// ⚠️ NEVER add a `dataCollection` key here, not even an empty one. Its mere
// PRESENCE flips the SDK's base options to full collection — IP addresses,
// cookies, and request bodies — and silently defeats `sendDefaultPii: false`
// (@sentry/core resolveDataCollectionOptions: `options.dataCollection != null
// ? DEFAULTS : defaultPiiToCollectionOptions(sendDefaultPii)`). The wizard
// scaffolds exactly such an empty block; it was removed on purpose.
Sentry.init({
  dsn: "https://9af30e90f6c079c5121e2c360000ff07@o4510320288137216.ingest.us.sentry.io/4511728774021120",

  // Explicitly OFF, not by omission (see server config note on the deprecated
  // flag vs `dataCollection`).
  sendDefaultPii: false,

  // 0 for /api/health*, 0.1 elsewhere.
  tracesSampler,

  beforeSend(event) {
    return scrubSentryEvent(event);
  },
  beforeSendTransaction(event) {
    return scrubSentryEvent(event);
  },
});
