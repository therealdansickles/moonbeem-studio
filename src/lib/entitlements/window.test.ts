// Fixtures for the rental window helpers. Run with:
//   npx tsx src/lib/entitlements/window.test.ts
// Pure module (no DB/network), so tsx runs it directly. Covers the NEW
// entitlementExpiresAt (Library v1) plus the boundary agreement with the existing
// isEntitlementActive gate — they share the two constants and must never disagree.

import {
  isEntitlementActive,
  entitlementExpiresAt,
  RENTAL_START_WINDOW_DAYS,
  RENTAL_PLAY_WINDOW_HOURS,
} from "./window";

let passed = 0;
let failed = 0;
function ok(cond: boolean, label: string) {
  if (cond) passed++;
  else {
    failed++;
    console.error(`  ✗ FAIL: ${label}`);
  }
}
function eq(a: unknown, b: unknown, label: string) {
  ok(JSON.stringify(a) === JSON.stringify(b), `${label} (got ${JSON.stringify(a)})`);
}

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const PURCHASED = "2026-06-01T00:00:00.000Z";
const PLAYED = "2026-06-10T12:00:00.000Z";

console.log("entitlementExpiresAt:");
eq(
  entitlementExpiresAt({ kind: "purchase", purchased_at: PURCHASED, first_played_at: null }),
  null,
  "purchase -> null (never expires)",
);
eq(
  entitlementExpiresAt({ kind: "rental", purchased_at: PURCHASED, first_played_at: null })?.toISOString(),
  new Date(new Date(PURCHASED).getTime() + RENTAL_START_WINDOW_DAYS * DAY_MS).toISOString(),
  "unstarted rental -> purchased_at + 30d",
);
eq(
  entitlementExpiresAt({ kind: "rental", purchased_at: PURCHASED, first_played_at: PLAYED })?.toISOString(),
  new Date(new Date(PLAYED).getTime() + RENTAL_PLAY_WINDOW_HOURS * HOUR_MS).toISOString(),
  "started rental -> first_played_at + 48h (purchased_at ignored once started)",
);

console.log("isEntitlementActive:");
{
  const purchase = { kind: "purchase", purchased_at: PURCHASED, first_played_at: null };
  eq(isEntitlementActive(purchase, new Date("2099-01-01T00:00:00Z")), true, "purchase always active");

  const unstarted = { kind: "rental", purchased_at: PURCHASED, first_played_at: null };
  eq(isEntitlementActive(unstarted, new Date(new Date(PURCHASED).getTime() + 29 * DAY_MS)), true, "unstarted, day 29 -> active");
  eq(isEntitlementActive(unstarted, new Date(new Date(PURCHASED).getTime() + 31 * DAY_MS)), false, "unstarted, day 31 -> expired");

  const started = { kind: "rental", purchased_at: PURCHASED, first_played_at: PLAYED };
  eq(isEntitlementActive(started, new Date(new Date(PLAYED).getTime() + 47 * HOUR_MS)), true, "started, hour 47 -> active");
  eq(isEntitlementActive(started, new Date(new Date(PLAYED).getTime() + 49 * HOUR_MS)), false, "started, hour 49 -> expired");
}

console.log("boundary at exactly now (the < edge; countdown and gate agree):");
{
  // Started rental: at now === expiry instant, the gate is FALSE (uses <), and the
  // derived expiry equals that exact instant.
  const started = { kind: "rental", purchased_at: PURCHASED, first_played_at: PLAYED };
  const startedExpiry = entitlementExpiresAt(started)!;
  eq(isEntitlementActive(started, startedExpiry), false, "started: now == expiry -> NOT active");
  eq(isEntitlementActive(started, new Date(startedExpiry.getTime() - 1)), true, "started: 1ms before expiry -> active");
  eq(startedExpiry.getTime(), new Date(PLAYED).getTime() + RENTAL_PLAY_WINDOW_HOURS * HOUR_MS, "started expiry instant exact");

  // Unstarted rental: same boundary agreement on the 30-day edge.
  const unstarted = { kind: "rental", purchased_at: PURCHASED, first_played_at: null };
  const unstartedExpiry = entitlementExpiresAt(unstarted)!;
  eq(isEntitlementActive(unstarted, unstartedExpiry), false, "unstarted: now == expiry -> NOT active");
  eq(isEntitlementActive(unstarted, new Date(unstartedExpiry.getTime() - 1)), true, "unstarted: 1ms before expiry -> active");
  eq(unstartedExpiry.getTime(), new Date(PURCHASED).getTime() + RENTAL_START_WINDOW_DAYS * DAY_MS, "unstarted expiry instant exact");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
