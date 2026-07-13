// Sentry server/edge event scrubbing + trace sampling — single source shared
// by sentry.server.config.ts and sentry.edge.config.ts so the two can't drift.
//
// Posture: Sentry is a third party. Nothing that authenticates a caller and
// no obvious PII may leave the box: auth/cookie headers are always stripped,
// /api/panel/* request bodies are dropped ENTIRELY (panel Bearer tokens are
// stored hash-only at rest — a plaintext token in an error event would be the
// only live copy anywhere), and obvious email fields are deleted elsewhere.

// Structural slice of Sentry's ErrorEvent/TransactionEvent — just the fields
// the scrubber touches, so one function serves beforeSend AND
// beforeSendTransaction without importing deep SDK types.
type RequestBearingEvent = {
  transaction?: string;
  user?: { ip_address?: string | null };
  request?: {
    url?: string;
    headers?: Record<string, string>;
    cookies?: unknown;
    data?: unknown;
  };
};

const EMAIL_FIELDS = ["email", "tipper_email"] as const;

export function scrubSentryEvent<E extends RequestBearingEvent>(event: E): E {
  // IP never leaves: an explicit null (vs. absent) also tells Sentry ingest
  // not to infer the address from the connection. Set unconditionally —
  // events without a user object get one carrying only the null.
  event.user = { ...event.user, ip_address: null };

  const req = event.request;
  if (!req) return event;

  // Credentials never leave, on any route. Sentry carries cookies BOTH as the
  // raw header (request.headers.cookie) and as a SEPARATE parsed request.cookies
  // map — deleting one does not touch the other (2026-07-13 gate finding: the
  // parsed map was shipping _ga / mb_consent / mb_aff on every event while the
  // header was already stripped).
  //
  // ⚠️ request.cookies is deleted OUTRIGHT, by design. Do NOT "improve" this by
  // relying on the SDK's built-in deny list instead: that list does redact
  // Supabase/auth cookie names today, but a vendor deny list is not a posture
  // across SDK versions — the field carries no value we need, so it goes.
  if (req.headers) {
    delete req.headers.authorization;
    delete req.headers.Authorization;
    delete req.headers.cookie;
    delete req.headers.Cookie;
  }
  delete req.cookies;

  // Panel surface: drop the whole body, don't try to be clever about which
  // field held the token.
  const isPanel =
    (event.transaction ?? "").includes("/api/panel/") ||
    (req.url ?? "").includes("/api/panel/");
  if (isPanel) {
    delete req.data;
    return event;
  }

  // Everywhere else: strip obvious email fields from parsed or JSON-string
  // bodies. Non-JSON string bodies pass through untouched.
  if (req.data && typeof req.data === "object") {
    for (const f of EMAIL_FIELDS) {
      delete (req.data as Record<string, unknown>)[f];
    }
  } else if (typeof req.data === "string") {
    try {
      const parsed = JSON.parse(req.data) as unknown;
      if (parsed && typeof parsed === "object") {
        for (const f of EMAIL_FIELDS) {
          delete (parsed as Record<string, unknown>)[f];
        }
        req.data = JSON.stringify(parsed);
      }
    } catch {
      // not JSON — leave as-is
    }
  }
  return event;
}

// /api/health and /api/health/[slug] are hit by uptime monitors around the
// clock — tracing them would be pure noise spend. Everything else samples at
// 10%.
export function tracesSampler(ctx: { name: string }): number {
  return ctx.name.includes("/api/health") ? 0 : 0.1;
}
