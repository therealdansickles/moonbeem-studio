// Application-layer rate limiting via Upstash Redis.
//
// Six tiers across the API surface; sliding-window across the board.
// Each route imports the appropriate limiter and calls `enforce()` at
// the top of its handler before any expensive work.
//
// Fail-open on Upstash outage by design: rate-limit infrastructure
// outages shouldn't take down the app. A 5xx from Upstash logs a
// warning and lets the request proceed. Worst case during an Upstash
// incident: a brief abuse window. Better than a hard dependency.
//
// Tiers:
//   tightAnon      — 10 req/min per IP  — username enumeration etc.
//   standardAnon   — 60 req/min per IP  — public reads, unsubscribe
//   chattyAnon     — 300 req/min per IP — anon analytics fire-hose
//   chattyAuthUser — 500 req/min per user — same surface but logged-in
//   userWrites     — 30 req/min per user — profile/me/notify mutations
//   partnerWrites  — 60 req/min per user — partner dashboard writes
//   creatorWrites  — 60 req/min per user — creator hosting-lane writes
//   admin          — 300 req/min per user — super-admin endpoints

import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { NextResponse, type NextRequest } from "next/server";

const url = process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN;

// Singleton Redis client. If env vars are missing, redis stays null
// and enforce() fails open with a one-time warning per route.
const redis = url && token ? new Redis({ url, token }) : null;

function makeLimiter(reqPerMinute: number, prefix: string): Ratelimit | null {
  if (!redis) return null;
  return new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(reqPerMinute, "60 s"),
    analytics: true,
    prefix: `mb:rl:${prefix}`,
  });
}

export const limiters = {
  tightAnon: makeLimiter(10, "tight"),
  standardAnon: makeLimiter(60, "std"),
  chattyAnon: makeLimiter(300, "chat"),
  chattyAuthUser: makeLimiter(500, "chat-u"),
  userWrites: makeLimiter(30, "user-w"),
  partnerWrites: makeLimiter(60, "partner-w"),
  creatorWrites: makeLimiter(60, "creator-w"),
  admin: makeLimiter(300, "admin"),
} as const;

export type LimiterKey = keyof typeof limiters;

// Extract a stable IP key from a NextRequest. Vercel sets
// x-forwarded-for as a comma-separated list; the first entry is the
// originating client (later entries are proxy hops).
export function getIp(request: NextRequest): string {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = request.headers.get("x-real-ip");
  if (real) return real;
  // Last-resort fallback so rate-limit state has *some* key. Means
  // unidentified clients share a bucket — acceptable since this only
  // hits in local dev or misconfigured ingress.
  return "unknown";
}

// Result shape returned by enforce(). When `response` is non-null the
// caller should `return response` immediately; otherwise proceed.
export type EnforceResult =
  | { ok: true; response: null }
  | { ok: false; response: NextResponse };

// Wraps Ratelimit.limit() with fail-open on Upstash errors. The
// `route` argument is just a label for 429-log lines so we can see
// which surface is being hit.
export async function enforce(
  tier: LimiterKey,
  key: string,
  route: string,
): Promise<EnforceResult> {
  const limiter = limiters[tier];
  if (!limiter) {
    // Either env vars missing or Upstash client failed to init. Log
    // once per process via a guard; otherwise we'd spam.
    warnMissingOnce();
    return { ok: true, response: null };
  }

  // Upstash REST round-trip is normally ~10-50ms. Cap at 250ms via
  // Promise.race so a real outage doesn't add multi-second latency
  // before the fail-open kicks in. (Verified empirically 2026-05-13:
  // an unreachable host caused ~4.6s elapsed without this guard.)
  let result;
  try {
    result = await Promise.race([
      limiter.limit(key),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("upstash-timeout-250ms")), 250),
      ),
    ]);
  } catch (err) {
    console.warn(
      `[ratelimit] upstash error, failing open: tier=${tier} route=${route} err=${err instanceof Error ? err.message : String(err)}`,
    );
    return { ok: true, response: null };
  }

  if (result.success) return { ok: true, response: null };

  const retryAfter = Math.max(1, Math.ceil((result.reset - Date.now()) / 1000));
  console.warn(
    `[ratelimit] 429 tier=${tier} route=${route} key=${maskKey(key)} limit=${result.limit} remaining=${result.remaining} retry_after=${retryAfter}s`,
  );

  return {
    ok: false,
    response: NextResponse.json(
      { error: "rate_limited", retry_after: retryAfter },
      {
        status: 429,
        headers: {
          "Retry-After": String(retryAfter),
          "X-RateLimit-Limit": String(result.limit),
          "X-RateLimit-Remaining": String(result.remaining),
          "X-RateLimit-Reset": String(Math.floor(result.reset / 1000)),
        },
      },
    ),
  };
}

// Mask user_ids / IPs in logs — first 8 chars are enough to debug
// patterns without writing full PII into Vercel log retention.
function maskKey(k: string): string {
  if (k.length <= 8) return k;
  return `${k.slice(0, 8)}…`;
}

let warned = false;
function warnMissingOnce() {
  if (warned) return;
  warned = true;
  console.warn(
    "[ratelimit] UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN not set; rate-limit calls failing open",
  );
}
