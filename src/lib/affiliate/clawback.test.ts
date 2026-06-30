/* eslint-disable */
// Standalone assertion tests for the clawback routing decision (Layer 3 Stage 3,
// policy C) — this repo has no test runner, so run directly:
//   npx tsx src/lib/affiliate/clawback.test.ts
//
// clawbackTargetStatus is the SPEC the two webhook handlers implement via two
// disjoint guarded UPDATEs (A: paid->reversed; B: the held/disputed->refunded or
// held->disputed update with 'paid' excluded). These assertions lock the
// held/paid divergence (the core Stage 3 behavior) + idempotency on every
// terminal.

import { clawbackTargetStatus, type PayoutStatus } from "./clawback";

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = got === want;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}  (got ${JSON.stringify(got)})`);
  if (!ok) {
    failures++;
    console.error(`     want ${JSON.stringify(want)}`);
  }
}

// --- refund ---
check("refund: held -> refunded", clawbackTargetStatus("held", "refund"), "refunded");
check("refund: disputed -> refunded (refund-wins, held-origin)", clawbackTargetStatus("disputed", "refund"), "refunded");
check("refund: paid -> reversed (ABSORB, the core Stage 3 divergence)", clawbackTargetStatus("paid", "refund"), "reversed");
check("refund: refunded -> null (idempotent terminal)", clawbackTargetStatus("refunded", "refund"), null);
check("refund: reversed -> null (idempotent terminal)", clawbackTargetStatus("reversed", "refund"), null);

// --- dispute ---
check("dispute: held -> disputed", clawbackTargetStatus("held", "dispute"), "disputed");
check("dispute: paid -> reversed (ABSORB, the core Stage 3 divergence)", clawbackTargetStatus("paid", "dispute"), "reversed");
check("dispute: refunded -> null (idempotent terminal)", clawbackTargetStatus("refunded", "dispute"), null);
check("dispute: reversed -> null (idempotent terminal)", clawbackTargetStatus("reversed", "dispute"), null);
check("dispute: disputed -> null (idempotent terminal)", clawbackTargetStatus("disputed", "dispute"), null);

// --- the held/paid distinction drives the divergence ---
check("held differs from paid on refund", clawbackTargetStatus("held", "refund") !== clawbackTargetStatus("paid", "refund"), true);
check("held differs from paid on dispute", clawbackTargetStatus("held", "dispute") !== clawbackTargetStatus("paid", "dispute"), true);

// --- every terminal is a no-op for BOTH events (idempotency) ---
const terminals: PayoutStatus[] = ["refunded", "reversed"];
for (const t of terminals) {
  check(`idempotent: ${t} refund -> null`, clawbackTargetStatus(t, "refund"), null);
  check(`idempotent: ${t} dispute -> null`, clawbackTargetStatus(t, "dispute"), null);
}

console.log(failures === 0 ? "\nRESULT: ALL GREEN" : `\nRESULT: ${failures} FAILURE(S)`);
if (failures > 0) process.exit(1);
