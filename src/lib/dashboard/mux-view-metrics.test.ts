// Unit tests for the partner-dashboard Mux view aggregation. The
// degrade-not-undercount rule is money-adjacent (a wrong partner number), so it
// gets pinned. Run: npx tsx src/lib/dashboard/mux-view-metrics.test.ts

import {
  aggregateMuxViewMetrics,
  formatWatchHours,
} from "./mux-view-metrics";

let failures = 0;
function eq(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.error(`  FAIL ${name} — got ${g}, want ${w}`);
  }
}

console.log("mux view aggregation");

// Happy path: sum views + watch time across titles.
eq(
  "sums all-ok titles",
  aggregateMuxViewMetrics([
    { ok: true, views: 10, watch_time_ms: 3_600_000 },
    { ok: true, views: 5, watch_time_ms: 1_800_000 },
  ]),
  { film_views: 15, watch_time_ms: 5_400_000 },
);

// Empty input is a real zero (empty catalog resolves to this upstream).
eq("empty input -> zero aggregate", aggregateMuxViewMetrics([]), {
  film_views: 0,
  watch_time_ms: 0,
});

// THE LOAD-BEARING ONE: any single failure poisons the WHOLE aggregate to null.
// A partial sum would be a wrong partner-facing number — degrade instead.
eq(
  "one failed title -> null (never a partial sum)",
  aggregateMuxViewMetrics([
    { ok: true, views: 100, watch_time_ms: 9_000_000 },
    { ok: false },
    { ok: true, views: 50, watch_time_ms: 4_000_000 },
  ]),
  null,
);
eq(
  "all failed -> null",
  aggregateMuxViewMetrics([{ ok: false }, { ok: false }]),
  null,
);

// Hours formatting (display of the ms field).
eq("watch hours < 10 keeps one decimal", formatWatchHours(3_600_000), "1.0 h");
eq("watch hours >= 10 rounds to integer", formatWatchHours(50_400_000), "14 h");
eq("zero watch time", formatWatchHours(0), "0.0 h");

if (failures > 0) {
  console.error(`\n${failures} FAILURE(S)`);
  process.exit(1);
}
console.log("\nall mux view aggregation tests passed");
