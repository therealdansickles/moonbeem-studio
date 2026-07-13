// This file configures the initialization of Sentry on the server.
// The config you add here will be used whenever the server handles a request.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/
//
// Hardening (see src/lib/sentry/scrub.ts for the shared scrubber/sampler):
// no default PII, auth/cookie headers stripped, /api/panel/* bodies dropped,
// email fields scrubbed, health-probe traces sampled at 0.

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

  // Explicitly OFF, not by omission. (Deprecated in SDK v10 in favor of
  // `dataCollection`, whose per-category defaults match "off"; we deliberately
  // do NOT set an empty `dataCollection` block because its presence makes the
  // SDK ignore this flag.)
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
