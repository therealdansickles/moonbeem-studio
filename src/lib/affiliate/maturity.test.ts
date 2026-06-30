/* eslint-disable */
// Standalone assertion tests for the affiliate maturity + withdraw-snapshot PURE
// logic — this repo has no test runner configured, so run directly:
//   npx tsx src/lib/affiliate/maturity.test.ts
//
// Covers the non-money logic that backs the withdraw producer:
//   - isAffiliateCutMature: the value-scaled hold (14d for cuts < $5, 60d for
//     >= $5), the boundary, and the unparseable-date conservative case.
//   - selectMaturedAffiliateRows: the snapshot == sum invariant (total_cents ===
//     Σ rows.cut_cents), maturity filtering, and the cut<=0 exclusion.
// (The route's gate/guard/transfer/flip branches are a FAITHFUL MIRROR of the
// proven campaign rail; they are not unit-testable as pure functions and are
// exercised only by the sk_test integration — never sk_live.)

import {
  isAffiliateCutMature,
  selectMaturedAffiliateRows,
} from "./maturity";

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) {
    failures++;
    console.error(`     got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
  }
}

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000; // fixed "now"

// --- isAffiliateCutMature: value-scaled hold ---
// normal cut (< $5 = 500c) -> 14-day hold
check("normal cut at 13d -> not mature", isAffiliateCutMature(30, NOW - 13 * DAY, NOW), false);
check("normal cut at 14d -> mature (<=)", isAffiliateCutMature(30, NOW - 14 * DAY, NOW), true);
check("normal cut at 15d -> mature", isAffiliateCutMature(30, NOW - 15 * DAY, NOW), true);
// high-value cut (>= $5 = 500c) -> 60-day hold
check("high cut at 14d -> NOT mature (60d hold)", isAffiliateCutMature(500, NOW - 14 * DAY, NOW), false);
check("high cut at 59d -> not mature", isAffiliateCutMature(500, NOW - 59 * DAY, NOW), false);
check("high cut at 60d -> mature (<=)", isAffiliateCutMature(500, NOW - 60 * DAY, NOW), true);
check("high cut at 61d -> mature", isAffiliateCutMature(1000, NOW - 61 * DAY, NOW), true);
// boundary: exactly 500c is high-value, 499c is normal
check("499c -> 14d rule (mature at 14d)", isAffiliateCutMature(499, NOW - 14 * DAY, NOW), true);
check("500c -> 60d rule (NOT mature at 14d)", isAffiliateCutMature(500, NOW - 14 * DAY, NOW), false);
// unparseable settled time -> false (conservative)
check("NaN settled -> not mature", isAffiliateCutMature(30, NaN, NOW), false);

// --- selectMaturedAffiliateRows: snapshot == sum + filtering ---
const isoAgo = (days: number) => new Date(NOW - days * DAY).toISOString();
const fetched = [
  { id: "a", affiliate_cut_cents: 30, settled_at: isoAgo(20) },   // normal, 20d -> mature
  { id: "b", affiliate_cut_cents: 30, settled_at: isoAgo(5) },    // normal, 5d  -> NOT mature
  { id: "c", affiliate_cut_cents: 800, settled_at: isoAgo(70) },  // high, 70d   -> mature
  { id: "d", affiliate_cut_cents: 800, settled_at: isoAgo(30) },  // high, 30d   -> NOT mature (60d hold)
  { id: "e", affiliate_cut_cents: 0, settled_at: isoAgo(100) },   // cut 0       -> excluded
  { id: "f", affiliate_cut_cents: null, settled_at: isoAgo(100) },// cut null    -> excluded
];
const sel = selectMaturedAffiliateRows(fetched, NOW);
check("selected rows = a + c (matured, cut>0)", sel.rows.map((r) => r.id).sort(), ["a", "c"]);
check("total_cents = 30 + 800 = 830", sel.total_cents, 830);
// THE invariant: total_cents === Σ rows.cut_cents (the transfer amount can't drift)
const sumOfRows = sel.rows.reduce((s, r) => s + r.cut_cents, 0);
check("SNAPSHOT==SUM: total_cents === Σ rows.cut_cents", sel.total_cents, sumOfRows);
// empty input -> {rows:[], total:0}
check("empty fetch -> zero", selectMaturedAffiliateRows([], NOW), { rows: [], total_cents: 0 });

console.log(failures === 0 ? "\nRESULT: ALL GREEN" : `\nRESULT: ${failures} FAILURE(S)`);
if (failures > 0) process.exit(1);
