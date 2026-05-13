// Public endpoint for FanEditModal user-action tracking.
//
// Auth is OPTIONAL — anonymous viewers count too. When the viewer is
// signed in, user_id is captured from the session cookie via getUser().
//
// Validation is permissive on shape (analytics shouldn't fail noisily)
// but strict on identity (fan_edit_id and event_type) so bad data
// doesn't reach the table.
//
// Geo capture (2026-05-14):
//   - Reads x-vercel-ip-country / x-vercel-ip-country-region /
//     x-vercel-ip-city from Vercel's edge.
//   - Persisted only when the visitor's analytics consent is true.
//   - Anon-no-decision visitors (no mb_consent cookie) → geo stays
//     NULL. The event row is still inserted for engagement metrics;
//     just no location.
//   - EU/UK/CH visitors default to analytics=false until explicit
//     accept, so their geo is NULL until they opt in.

import { NextResponse, type NextRequest } from "next/server";
import { getUser } from "@/lib/dal";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { enforce, getIp } from "@/lib/ratelimit";
import {
  CONSENT_COOKIE_NAME,
  type ConsentState,
} from "@/lib/consent/types";

const ALLOWED_EVENT_TYPES = [
  "modal_open",
  "modal_close",
  "view_on_platform_click",
] as const;
type EventType = (typeof ALLOWED_EVENT_TYPES)[number];

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SESSION_ID_MAX_LEN = 64;

// Field length caps. Vercel city values are typically short, but the
// header isn't authenticated and could in principle be spoofed by an
// origin-server-bypass; truncate defensively.
const COUNTRY_CODE_MAX_LEN = 8;
const REGION_CODE_MAX_LEN = 16;
const CITY_MAX_LEN = 100;

/**
 * Parses the mb_consent cookie on the request and returns true iff
 * the visitor has explicitly granted analytics consent. No cookie,
 * malformed cookie, or analytics=false all return false.
 */
function hasAnalyticsConsent(request: NextRequest): boolean {
  const raw = request.cookies.get(CONSENT_COOKIE_NAME)?.value;
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw) as Partial<ConsentState>;
    return parsed.analytics === true;
  } catch {
    return false;
  }
}

/**
 * Reads Vercel geo headers when present. Vercel URL-encodes the city
 * header (spaces → %20, non-ASCII → percent-escaped); we decode it
 * before persisting. country_code is ISO-3166-1 alpha-2.
 */
function readGeo(request: NextRequest): {
  country_code: string | null;
  region_code: string | null;
  city: string | null;
} {
  const rawCountry = request.headers.get("x-vercel-ip-country");
  const rawRegion = request.headers.get("x-vercel-ip-country-region");
  const rawCity = request.headers.get("x-vercel-ip-city");

  let city: string | null = null;
  if (rawCity) {
    try {
      city = decodeURIComponent(rawCity);
    } catch {
      city = rawCity;
    }
  }

  return {
    country_code: rawCountry?.slice(0, COUNTRY_CODE_MAX_LEN) ?? null,
    region_code: rawRegion?.slice(0, REGION_CODE_MAX_LEN) ?? null,
    city: city?.slice(0, CITY_MAX_LEN) ?? null,
  };
}

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  const obj = body as Record<string, unknown>;

  const fanEditId = obj.fan_edit_id;
  const eventType = obj.event_type;
  if (typeof fanEditId !== "string" || !UUID_RE.test(fanEditId)) {
    return NextResponse.json(
      { error: "invalid fan_edit_id" },
      { status: 400 },
    );
  }
  if (
    typeof eventType !== "string" ||
    !ALLOWED_EVENT_TYPES.includes(eventType as EventType)
  ) {
    return NextResponse.json(
      { error: "invalid event_type" },
      { status: 400 },
    );
  }

  const durationMsRaw = obj.duration_ms;
  const durationMs =
    typeof durationMsRaw === "number" && Number.isFinite(durationMsRaw)
      ? Math.max(0, Math.round(durationMsRaw))
      : null;

  const sessionIdRaw = obj.session_id;
  const sessionId =
    typeof sessionIdRaw === "string"
      ? sessionIdRaw.slice(0, SESSION_ID_MAX_LEN)
      : null;

  const metadataRaw = obj.metadata;
  const metadata =
    metadataRaw && typeof metadataRaw === "object" && !Array.isArray(metadataRaw)
      ? (metadataRaw as Record<string, unknown>)
      : null;

  // Session is loaded anyway to capture user_id below; branch the
  // rate-limit tier on auth state without added overhead. Authed users
  // get a more generous per-user budget (modal arrow-nav + Trending
  // exploration can plausibly exceed the 300/min IP limit).
  const user = await getUser();
  const limit = user
    ? await enforce("chattyAuthUser", user.id, "analytics/modal-event")
    : await enforce("chattyAnon", getIp(request), "analytics/modal-event");
  if (!limit.ok) return limit.response;

  // Geo capture is consent-gated. Anon-no-decision → NULL geo.
  const geo = hasAnalyticsConsent(request)
    ? readGeo(request)
    : { country_code: null, region_code: null, city: null };

  const supabase = createServiceRoleClient();
  const { error } = await supabase.from("fan_edit_events").insert({
    fan_edit_id: fanEditId,
    event_type: eventType,
    duration_ms: durationMs,
    user_id: user?.id ?? null,
    session_id: sessionId,
    metadata,
    country_code: geo.country_code,
    region_code: geo.region_code,
    city: geo.city,
  });

  if (error) {
    console.error("[analytics] modal-event insert failed:", error.message);
    return NextResponse.json({ error: "insert failed" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
