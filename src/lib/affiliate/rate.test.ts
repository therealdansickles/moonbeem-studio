/* eslint-disable */
// Standalone assertion tests for the affiliate exact-bps PURE logic — this repo
// has no test runner configured, so run directly:
//   npx tsx src/lib/affiliate/rate.test.ts
//
// Covers the canonical exact-bps rule and its numeric-string front door, unified
// here so the rate-control write guard and the settle pass can't drift:
//   - fractionToExactBps: exact mapping, the 1e-6 non-exact tolerance, negative
//     and NaN rejection, the zero case.
//   - numericStringToExactBps: the string parse, AND the CRITICAL null->null
//     short-circuit (a null take-rate must be REFUSED by the settle pass, never
//     settled at 0 bps — Number(null) would be 0, which is the bug this guards).

import { fractionToExactBps, numericStringToExactBps } from "./rate";

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) {
    failures++;
    console.error(`     got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
  }
}

// --- fractionToExactBps: the canonical core ---
check("0.15 -> 1500", fractionToExactBps(0.15), 1500);
check("0.1055 -> 1055", fractionToExactBps(0.1055), 1055);
check("0.10555 -> null (non-exact, |scaled-bps|>1e-6)", fractionToExactBps(0.10555), null);
check("-0.01 -> null (negative)", fractionToExactBps(-0.01), null);
check("NaN -> null", fractionToExactBps(NaN), null);
check("0 -> 0", fractionToExactBps(0), 0);
check("0.5 (cap) -> 5000", fractionToExactBps(0.5), 5000);

// --- numericStringToExactBps: string front door + the CRITICAL null guard ---
check("null -> null (REFUSE, not 0 — the settlement-safety guard)", numericStringToExactBps(null), null);
check('"0.15" -> 1500', numericStringToExactBps("0.15"), 1500);
check('"0.10" -> 1000', numericStringToExactBps("0.10"), 1000);
check('"abc" -> null (NaN)', numericStringToExactBps("abc"), null);
check('"" -> 0 (Number("")===0, matches legacy toExactBps)', numericStringToExactBps(""), 0);
check('"0.10555" -> null (non-exact)', numericStringToExactBps("0.10555"), null);
check('"-0.01" -> null (negative)', numericStringToExactBps("-0.01"), null);

// Equivalence: numericStringToExactBps(rate) === (rate===null ? null : fractionToExactBps(Number(rate)))
for (const r of ["0.15", "0.1055", "0.10555", "", "abc", "-0.01", "0", "0.5"]) {
  check(
    `equiv for ${JSON.stringify(r)}`,
    numericStringToExactBps(r),
    fractionToExactBps(Number(r)),
  );
}
check(
  "equiv for null",
  numericStringToExactBps(null),
  null,
);

console.log(failures === 0 ? "\nALL GREEN" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
