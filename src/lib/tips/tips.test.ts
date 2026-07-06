// Critical real-path proof for tips (run: npx tsx src/lib/tips/tips.test.ts).
// A tip writes ONE transaction_settlements row (affiliate_cut = gross), so
// getAffiliateBalance auto-counts it (it sums affiliate_cut_cents > 0 by
// creator_id). Here we prove the pure pieces that feed that path AND that a tip
// cut survives the REAL maturity-hold + clawback-C functions the balance/withdraw
// rails use — no phantom kind-set, the actual shipped functions.
import {
  MIN_TIP_CENTS,
  MAX_TIP_CENTS,
  validateTipAmountCents,
} from "./amount";
import { buildTipSettlementLegs, tipSettlementSumOk } from "./settlement";
import {
  isAffiliateCutMature,
  HOLD_LOW_MS,
  HOLD_HIGH_MS,
  HIGH_VALUE_CUT_CENTS,
} from "../affiliate/maturity";
import { clawbackTargetStatus } from "../affiliate/clawback";

let passed = 0;
let failed = 0;
function eq(a: unknown, b: unknown, label: string) {
  if (JSON.stringify(a) === JSON.stringify(b)) passed++;
  else {
    failed++;
    console.error(`  ✗ FAIL: ${label} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
  }
}

console.log("validateTipAmountCents ($2 floor / $500 ceiling):");
eq(validateTipAmountCents(200), { ok: true, cents: 200 }, "$2 exactly -> ok");
eq(validateTipAmountCents(50000), { ok: true, cents: 50000 }, "$500 exactly -> ok");
eq(validateTipAmountCents(199), { ok: false, error: "below_minimum" }, "$1.99 -> below_minimum");
eq(validateTipAmountCents(50001), { ok: false, error: "above_maximum" }, "$500.01 -> above_maximum");
eq(validateTipAmountCents(2.5), { ok: false, error: "not_integer" }, "fractional cents -> not_integer");
eq(validateTipAmountCents("500"), { ok: false, error: "not_integer" }, "string -> not_integer");
eq(MIN_TIP_CENTS, 200, "floor is $2");
eq(MAX_TIP_CENTS, 50000, "ceiling is $500");

console.log("tip settlement legs (creator 100%, fee absorbed, sum invariant):");
for (const amt of [200, 500, 1000, 2000, 50000]) {
  const legs = buildTipSettlementLegs(amt);
  eq(legs.affiliate_cut_cents, amt, `$${amt / 100}: creator owed 100% (affiliate_cut = gross)`);
  eq(legs.stripe_fee_cents, 0, `$${amt / 100}: stripe_fee 0 (absorbed)`);
  eq(legs.moonbeem_take_cents, 0, `$${amt / 100}: platform take 0`);
  eq(legs.distributor_net_cents, 0, `$${amt / 100}: no distributor`);
  eq(legs.creator_share_bps, 10000, `$${amt / 100}: creator_share_bps 10000`);
  eq(tipSettlementSumOk(legs), true, `$${amt / 100}: DB sum invariant holds`);
}

console.log("maturity — the tip cut on the REAL value-scaled hold:");
const NOW = 1_800_000_000_000; // fixed epoch (ms) for determinism
// $2 tip cut (200c) is a NORMAL cut (< $5) -> 14-day hold.
eq(HIGH_VALUE_CUT_CENTS, 500, "high-value threshold is $5");
eq(isAffiliateCutMature(200, NOW - HOLD_LOW_MS - 1, NOW), true, "$2 cut, 14d+ elapsed -> mature/available");
eq(isAffiliateCutMature(200, NOW - HOLD_LOW_MS + 60_000, NOW), false, "$2 cut, just under 14d -> pending");
// $5 tip cut (500c) is HIGH value -> 60-day hold (14d is NOT enough).
eq(isAffiliateCutMature(500, NOW - HOLD_LOW_MS - 1, NOW), false, "$5 cut, 14d elapsed -> still pending (needs 60d)");
eq(isAffiliateCutMature(500, NOW - HOLD_HIGH_MS - 1, NOW), true, "$5 cut, 60d+ elapsed -> mature");
eq(isAffiliateCutMature(50000, NOW - HOLD_HIGH_MS - 1, NOW), true, "$500 cut, 60d+ elapsed -> mature");

console.log("clawback policy-C — a tip cut refunded/disputed, REAL routing:");
eq(clawbackTargetStatus("held", "refund"), "refunded", "held tip cut + refund -> refunded (block payout)");
eq(clawbackTargetStatus("paid", "refund"), "reversed", "paid tip cut + refund -> reversed (absorb)");
eq(clawbackTargetStatus("held", "dispute"), "disputed", "held tip cut + dispute -> disputed");
eq(clawbackTargetStatus("paid", "dispute"), "reversed", "paid tip cut + dispute -> reversed (absorb)");
eq(clawbackTargetStatus("refunded", "refund"), null, "already refunded -> no-op (idempotent)");

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
