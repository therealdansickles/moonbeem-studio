// Fixtures for the pure scrape budget guard (step 2, ruling X). Run with:
//   npx tsx src/lib/source-accounts/budget.test.ts
// Pure module (like normalize/backoff), so tsx runs it directly. The live glue
// (getUsedUnits read, chokepoint abort, cron per-account consult) is proven in the
// Gate B/C verification; here we prove the arithmetic + reservation + fail-closed.

import {
  resolveBudgetConfig,
  hoursRemainingInUtcDay,
  nextUtcMidnight,
  projectedUnits,
  scrapeBudgetDecision,
  describeBudgetAbort,
  DEFAULT_BUDGET,
  DEFAULT_CUTOFF_PCT,
  DEFAULT_VT_DAILY_ESTIMATE,
  type BudgetConfig,
} from "./budget";

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

const DEFAULTS: BudgetConfig = {
  budget: DEFAULT_BUDGET,
  cutoffPct: DEFAULT_CUTOFF_PCT,
  vtDailyEstimate: DEFAULT_VT_DAILY_ESTIMATE,
};

console.log("config resolution (defaults ARM the guard; env overrides):");
eq(resolveBudgetConfig({}), DEFAULTS, "empty env -> 4000 / 0.85 / 1200 defaults");
eq(
  resolveBudgetConfig({ ENSEMBLEDATA_DAILY_UNIT_BUDGET: "5000" }).budget,
  5000,
  "budget override",
);
eq(
  resolveBudgetConfig({ ENSEMBLEDATA_SCRAPE_CUTOFF_PCT: "0.9" }).cutoffPct,
  0.9,
  "cutoff override",
);
eq(
  resolveBudgetConfig({ ENSEMBLEDATA_VIEW_TRACKING_DAILY_ESTIMATE: "1500" }).vtDailyEstimate,
  1500,
  "vt estimate override",
);
eq(resolveBudgetConfig({ ENSEMBLEDATA_DAILY_UNIT_BUDGET: "" }).budget, 4000, "blank -> default");
eq(
  resolveBudgetConfig({ ENSEMBLEDATA_DAILY_UNIT_BUDGET: "not-a-number" }).budget,
  4000,
  "NaN -> default (never a garbage budget)",
);

console.log("UTC day math:");
eq(hoursRemainingInUtcDay(new Date(Date.UTC(2026, 6, 3, 0, 0, 0))), 24, "00:00 UTC -> 24h");
eq(hoursRemainingInUtcDay(new Date(Date.UTC(2026, 6, 3, 12, 0, 0))), 12, "12:00 UTC -> 12h");
eq(hoursRemainingInUtcDay(new Date(Date.UTC(2026, 6, 3, 23, 0, 0))), 1, "23:00 UTC -> 1h");
eq(
  nextUtcMidnight(new Date(Date.UTC(2026, 6, 3, 12, 30, 0))).toISOString(),
  "2026-07-04T00:00:00.000Z",
  "next UTC midnight rolls the date",
);

console.log("projected units (worst-case ceiling):");
eq(projectedUnits(8, 3), 250, "incremental 8*3 pages -> 250");
eq(projectedUnits(8, 6), 490, "backfill 8*6 pages -> 490");

console.log("reservation pro-rate (scrapes cannot starve view-tracking):");
{
  const early = scrapeBudgetDecision({
    config: DEFAULTS,
    hoursRemaining: 24,
    unitsToday: 0,
    projected: 250,
  });
  eq(early.reservedVt, 1200, "00:00 -> reserve full 1200 for VT");
  eq(early.softCeiling, 3400, "soft ceiling = floor(4000*0.85)");
  eq(early.hardCeiling, 2800, "hard ceiling = 4000 - 1200");
  eq(early.scrapeCeiling, 2800, "early ceiling = min(3400,2800) = 2800");

  const late = scrapeBudgetDecision({
    config: DEFAULTS,
    hoursRemaining: 2,
    unitsToday: 0,
    projected: 250,
  });
  eq(late.reservedVt, 100, "2h left -> reserve ~100 for VT");
  eq(late.hardCeiling, 3900, "hard ceiling = 4000 - 100");
  eq(late.scrapeCeiling, 3400, "late ceiling = min(3400,3900) = 3400 (soft binds)");
}

console.log("allow / abort + labeled bound:");
{
  const allow = scrapeBudgetDecision({
    config: DEFAULTS,
    hoursRemaining: 24,
    unitsToday: 1000,
    projected: 250,
  });
  eq(allow.allow, true, "1000+250=1250 <= 2800 -> allow");
  eq(allow.reason, "ok", "allow reason ok");

  // late day, soft cap binds: ceiling 3400, 3300+250=3550 > 3400
  const soft = scrapeBudgetDecision({
    config: DEFAULTS,
    hoursRemaining: 2,
    unitsToday: 3300,
    projected: 250,
  });
  eq(soft.allow, false, "3550 > 3400 -> abort");
  eq(soft.reason, "soft_cap", "soft cutoff is the binding bound late-day");

  // early day, VT reservation binds: ceiling 2800 (hard<soft), 2700+250=2950 > 2800
  const vt = scrapeBudgetDecision({
    config: DEFAULTS,
    hoursRemaining: 24,
    unitsToday: 2700,
    projected: 250,
  });
  eq(vt.allow, false, "2950 > 2800 -> abort");
  eq(vt.reason, "vt_reservation", "VT reservation is the binding bound early-day");

  // boundary: wouldReach exactly == ceiling -> allow (<=)
  const boundary = scrapeBudgetDecision({
    config: DEFAULTS,
    hoursRemaining: 2,
    unitsToday: 3150,
    projected: 250,
  });
  eq(boundary.wouldReach, 3400, "wouldReach 3400");
  eq(boundary.allow, true, "exactly at the 3400 ceiling -> allow");
}

console.log("fail-closed (meter unreadable):");
{
  const down = scrapeBudgetDecision({
    config: DEFAULTS,
    hoursRemaining: 12,
    unitsToday: null,
    projected: 250,
  });
  eq(down.allow, false, "meter null -> refuse (never spend blind)");
  eq(down.reason, "meter_unavailable", "reason meter_unavailable");
  eq(down.wouldReach, null, "no wouldReach when meter down");
}

console.log("env override changes the ceiling:");
{
  const bigger = scrapeBudgetDecision({
    config: { budget: 8000, cutoffPct: 0.85, vtDailyEstimate: 1200 },
    hoursRemaining: 24,
    unitsToday: 2700,
    projected: 250,
  });
  eq(bigger.allow, true, "same load allowed under an 8000 budget");
}

console.log("labeled abort strings carry the evidence:");
{
  const d = scrapeBudgetDecision({
    config: DEFAULTS,
    hoursRemaining: 2,
    unitsToday: 3300,
    projected: 250,
  });
  const msg = describeBudgetAbort(d, "2026-07-04T00:00:00.000Z");
  ok(msg.includes("3300/4000"), "abort msg states units/budget");
  ok(msg.includes("~250"), "abort msg states projected");
  ok(msg.includes("3400-unit ceiling"), "abort msg states the ceiling");
  ok(msg.includes("2026-07-04"), "abort msg states the retry horizon");
  ok(msg.includes("view-tracking is never blocked"), "abort msg reaffirms the invariant");

  const down = describeBudgetAbort(
    scrapeBudgetDecision({
      config: DEFAULTS,
      hoursRemaining: 12,
      unitsToday: null,
      projected: 250,
    }),
    "2026-07-04T00:00:00.000Z",
  );
  ok(down.includes("fails closed"), "meter-down msg says fail-closed");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
