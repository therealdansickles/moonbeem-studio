// Fixtures for the pure Step-1.5 backoff decisions — run with:
//   npx tsx supabase/functions/view-tracking/backoff.test.ts
// backoff.ts is Deno-free, so tsx runs it directly. The DB-side §9 items
// (healthy-row-unaffected due gate, recovery-clears-both, backoff-entry window)
// are structural glue verified in Gate 5 post-deploy; here we prove the decisions.

import {
  ladderBackoffMs,
  isParseDeathCandidate,
  deathProceeds,
  failureCounterClass,
  PARSE_DEATH_COUNT,
  RATE_LIMITED_BACKOFF_MS,
  BREAKER_MIN_SUCCESSES_24H,
  BREAKER_SMALL_N,
} from "./backoff";

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
const H = 3_600_000;

console.log("ladder (backoff-entry + ladder-honored):");
eq(ladderBackoffMs(1), 1 * H, "n=1 → 1h");
eq(ladderBackoffMs(2), 6 * H, "n=2 → 6h");
eq(ladderBackoffMs(3), 24 * H, "n=3 → 24h");
eq(ladderBackoffMs(6), 24 * H, "n=6 → 24h");
eq(
  ladderBackoffMs(1) + ladderBackoffMs(2) + ladderBackoffMs(3) + ladderBackoffMs(4) + ladderBackoffMs(5),
  (1 + 6 + 24 + 24 + 24) * H,
  "cumulative span before the n=6 death = 79h (≥72h guaranteed)",
);

console.log("death candidacy (parse_error-only at n≥6):");
eq(PARSE_DEATH_COUNT, 6, "death threshold constant = 6");
eq(isParseDeathCandidate("parse_error", 5), false, "parse_error n=5 → not yet");
eq(isParseDeathCandidate("parse_error", 6), true, "parse_error n=6 → death candidate");
eq(isParseDeathCandidate("parse_error", 7), true, "parse_error n=7 → death candidate");
eq(isParseDeathCandidate("transient", 6), false, "transient never dies (n=6)");
eq(isParseDeathCandidate("transient", 99), false, "transient never dies (n=99, e.g. 72h ED outage)");
eq(isParseDeathCandidate("write_failed", 99), false, "write_failed never dies");
eq(isParseDeathCandidate("rate_limited", 99), false, "rate_limited never a death candidate");

console.log("rate_limited inert:");
ok(RATE_LIMITED_BACKOFF_MS < ladderBackoffMs(1), "rate_limited backoff < the 1h ladder rung");
eq(RATE_LIMITED_BACKOFF_MS, 15 * 60_000, "rate_limited backoff = 15m");

console.log("class isolation (Fold 1):");
eq(failureCounterClass("parse_error"), "refresh", "parse_error → refresh_failure_count");
eq(failureCounterClass("transient"), "refresh", "transient → refresh_failure_count");
eq(failureCounterClass("write_failed"), "refresh", "write_failed → refresh_failure_count");
eq(failureCounterClass("not_found"), "view_tracking", "not_found → view_tracking_failure_count");
eq(failureCounterClass("private"), "view_tracking", "private → view_tracking_failure_count");
eq(failureCounterClass("rate_limited"), "none", "rate_limited advances neither counter");

console.log("trailing-success breaker (§4):");
eq(BREAKER_MIN_SUCCESSES_24H, 5, "min successes = 5");
eq(BREAKER_SMALL_N, 5, "small-N floor = 5");
// small-N floor: twitter's single row dies at n≥6 even with 0 healthy peers
eq(deathProceeds(0, 1), true, "small-N floor: active=1, successes=0 → death PROCEEDS");
eq(deathProceeds(0, 4), true, "small-N floor: active=4 → death PROCEEDS");
// cohort domination — the exact case the old in-run ratio got wrong: a dominant
// broken cohort can't shield itself if ≥5 OTHER platform rows are healthy.
eq(deathProceeds(5, 100), true, "cohort domination: successes_24h=5 → PROCEEDS");
eq(deathProceeds(9, 200), true, "cohort domination: 14 candidates but 9 healthy → PROCEEDS");
// systemic: platform-wide all-null (0 successes) with ≥5 active → suppress
eq(deathProceeds(0, 5), false, "systemic: successes_24h=0, active=5 → SUPPRESSED");
eq(deathProceeds(4, 20), false, "systemic-ish: successes_24h=4 (<5), active≥5 → SUPPRESSED");
eq(deathProceeds(5, 5), true, "boundary: exactly 5 successes → PROCEEDS");

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
