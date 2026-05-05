// Shared click-logger for the /go/ redirect handlers.
//
// Called by /go/[code] (Flow C: affiliate links) and /go/offer
// (Flows A + B: direct offer-button clicks). Logs one row to
// external_clicks per click with bot detection, Vercel geo headers,
// inbound UTMs, and platform inference from referrer.
//
// Latency contract: the caller does not await the insert before
// redirecting. Internally we Promise.race the insert against a
// 100ms timeout — most DB writes complete within that window;
// anything slower fires-and-continues so the redirect isn't blocked.
// Slow writes after the timeout may be terminated when the serverless
// function returns; this is an accepted v1 tradeoff. Edge runtime's
// ctx.waitUntil would solve it cleanly if we ever flip /go/* to Edge.

import type { NextRequest } from "next/server";
import { detectBot } from "@/lib/bot-detection";
import { createServiceRoleClient } from "@/lib/supabase/service";

const WRITE_TIMEOUT_MS = 100;

// Referrer host → platform mapping. Subdomains match too (e.g.
// m.tiktok.com → tiktok). x.com / twitter.com / t.co all collapse to
// 'twitter' since the data semantics (posted-from-Twitter) are the
// same regardless of the rebrand.
const HOST_TO_PLATFORM: ReadonlyArray<readonly [string, string]> = [
  ["tiktok.com", "tiktok"],
  ["instagram.com", "instagram"],
  ["twitter.com", "twitter"],
  ["x.com", "twitter"],
  ["t.co", "twitter"],
  ["youtube.com", "youtube"],
  ["youtu.be", "youtube"],
];

export type LogClickArgs = {
  request: NextRequest;
  title_id: string;
  title_offer_id?: string | null;
  affiliate_link_id?: string | null;
  creator_id?: string | null;
};

export async function logClick(args: LogClickArgs): Promise<void> {
  const { request } = args;
  const headers = request.headers;
  const url = new URL(request.url);

  const userAgent = headers.get("user-agent");
  const { isBot, signature } = detectBot(userAgent);

  // Vercel geo headers are URL-encoded for the city (handles
  // multibyte characters and spaces). decodeURIComponent is safe
  // against malformed input via the try/catch.
  const cityRaw = headers.get("x-vercel-ip-city");
  let city: string | null = null;
  if (cityRaw) {
    try {
      city = decodeURIComponent(cityRaw) || null;
    } catch {
      city = cityRaw || null;
    }
  }
  const region_code = headers.get("x-vercel-ip-country-region") || null;
  const country_code = headers.get("x-vercel-ip-country") || null;

  const referrer = headers.get("referer") || null;
  const platform = detectPlatformFromReferrer(referrer);

  // Inbound UTMs from the click. Only utm_medium gets a column today
  // (per existing schema). The others are ignored at write time;
  // future migration could add a utms jsonb column if we want them.
  const utm_medium = url.searchParams.get("utm_medium") || null;

  const supabase = createServiceRoleClient();
  const insertRow = {
    title_id: args.title_id,
    title_offer_id: args.title_offer_id ?? null,
    affiliate_link_id: args.affiliate_link_id ?? null,
    creator_id: args.creator_id ?? null,
    referrer,
    platform,
    utm_medium,
    city,
    region_code,
    country_code,
    is_bot: isBot,
    bot_signature: signature,
  };

  let completed = false;
  const insertPromise = (async () => {
    try {
      const res = await supabase
        .from("external_clicks")
        .insert(insertRow);
      completed = true;
      if (res.error) {
        console.error(
          `[click-logger] insert failed: ${res.error.code} ${res.error.message}`,
        );
      }
    } catch (err) {
      completed = true;
      console.error(
        `[click-logger] insert threw: ${err instanceof Error ? err.message : err}`,
      );
    }
  })();

  await Promise.race([
    insertPromise,
    new Promise<void>((resolve) =>
      setTimeout(resolve, WRITE_TIMEOUT_MS)
    ),
  ]);

  if (!completed) {
    console.warn(
      `[click-logger] insert exceeded ${WRITE_TIMEOUT_MS}ms — ` +
        `fire-and-continue (write may be terminated when handler returns)`,
    );
  }
}

function detectPlatformFromReferrer(ref: string | null): string | null {
  if (!ref) return null;
  try {
    const host = new URL(ref).hostname.toLowerCase();
    for (const [needle, platform] of HOST_TO_PLATFORM) {
      if (host === needle || host.endsWith("." + needle)) {
        return platform;
      }
    }
  } catch {
    // Malformed referrer header — treat as unknown.
  }
  return null;
}

// Helper for the route handlers: append outbound UTMs to a destination
// URL while preserving any existing query string. Returns the original
// url string unchanged if it can't be parsed (e.g. relative path).
export function appendOutboundUtms(
  destinationUrl: string,
  utms: Record<string, string>,
): string {
  try {
    const u = new URL(destinationUrl);
    for (const [k, v] of Object.entries(utms)) {
      u.searchParams.set(k, v);
    }
    return u.toString();
  } catch {
    return destinationUrl;
  }
}
