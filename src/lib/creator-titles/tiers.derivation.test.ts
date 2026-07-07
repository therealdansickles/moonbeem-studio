// Ruling-encoded fixtures for the creator-hosting status derivation.
// Run with:
//   npx tsx src/lib/creator-titles/tiers.derivation.test.ts
//
// WHAT THIS IS. A guard on the DERIVATION RULINGS behind getCreatorHostingStatus
// (src/lib/creator-titles/tiers.ts). getCreatorHostingStatus is DB-coupled
// (service-role reads + the storage view), so it cannot be called from a pure
// tsx harness; this file transcribes ONLY the pure derivation from tiers.ts and
// checks it against hand-written expectations.
//
// TAUTOLOGY HAZARD (named, per Dan's ruling). The `derive()` below is transcribed
// from tiers.ts, so it partly tests the code against itself. The defense is the
// EXPECTED values: they are LITERALS that encode the RULINGS directly —
//   • pending-cancel  = (cancel_at set) OR (cancel_at_period_end true)
//   • grandfather     = billable clamps to max(0, used - floor)
//   • canceled sub    = falls back to free; its stale cancel fields are ignored
// — and are NEVER computed by calling derive(). A wrong transcription diverges
// from the literals and FAILS. What this does NOT catch: tiers.ts's real formula
// drifting from this transcription (accepted residual — see the source-line cites
// so a reviewer can eyeball-diff). Source of truth, verbatim:
//   TIER_ALLOTMENT_MINUTES → tiers.ts:22-27   TIER_ALLOWS_4K → tiers.ts:38-43
//   getCreatorTier rule    → tiers.ts:75-83   gate math      → tiers.ts:125-155

const TIER_ALLOTMENT_MINUTES: Record<string, number> = {
  free: 120, solo: 600, studio: 2400, pro: 9000, // tiers.ts:22-27
};
const TIER_ALLOWS_4K: Record<string, boolean> = {
  free: false, solo: false, studio: true, pro: true, // tiers.ts:38-43
};

type Fixture = {
  name: string;
  subStatus: "active" | "trialing" | "canceled" | "none";
  subTier: "solo" | "studio" | "pro" | null;
  usedEncodeMinutes: number;
  grandfatheredFloorMinutes: number;
  cancel_at: string | null; // flexible-billing timestamp
  cancel_at_period_end: boolean; // legacy flag ("cape")
  // EXPECTED: literals encoding the rulings — never derive() output.
  expect: {
    tier: string; billableMinutes: number; remainingMinutes: number;
    atCeiling: boolean; pendingCancel: boolean; cancelAt: string | null; allows4k: boolean;
  };
};

// Transcription of getCreatorTier (tiers.ts:75-83) + getCreatorHostingStatus
// (tiers.ts:125-155). The live-sub query is .in(["active","trialing"]) — so a
// non-live sub row is NEVER returned, i.e. its cancel fields are never read.
function derive(f: Fixture) {
  const live = f.subStatus === "active" || f.subStatus === "trialing";
  const tier = live && f.subTier ? f.subTier : "free"; // getCreatorTier
  const allotmentMinutes = TIER_ALLOTMENT_MINUTES[tier];
  const billableMinutes = Math.max(0, f.usedEncodeMinutes - f.grandfatheredFloorMinutes); // :132-135
  const remainingMinutes = Math.max(0, allotmentMinutes - billableMinutes); // :136
  const atCeiling = billableMinutes >= allotmentMinutes; // :151
  const cancelAt = live ? (f.cancel_at ?? null) : null; // :140 (only a live row exists)
  const pendingCancel = cancelAt != null || (live ? !!f.cancel_at_period_end : false); // :141
  const allows4k = TIER_ALLOWS_4K[tier]; // :152
  return { tier, billableMinutes, remainingMinutes, atCeiling, pendingCancel, cancelAt, allows4k };
}

const FIXTURES: Fixture[] = [
  { name: "1: Free, no sub, under cap",
    subStatus: "none", subTier: null, usedEncodeMinutes: 40, grandfatheredFloorMinutes: 0,
    cancel_at: null, cancel_at_period_end: false,
    expect: { tier: "free", billableMinutes: 40, remainingMinutes: 80, atCeiling: false, pendingCancel: false, cancelAt: null, allows4k: false } },

  { name: "2: Solo active, under cap",
    subStatus: "active", subTier: "solo", usedEncodeMinutes: 300, grandfatheredFloorMinutes: 0,
    cancel_at: null, cancel_at_period_end: false,
    expect: { tier: "solo", billableMinutes: 300, remainingMinutes: 300, atCeiling: false, pendingCancel: false, cancelAt: null, allows4k: false } },

  { name: "3: Solo active, exactly at cap (>= boundary)",
    subStatus: "active", subTier: "solo", usedEncodeMinutes: 600, grandfatheredFloorMinutes: 0,
    cancel_at: null, cancel_at_period_end: false,
    expect: { tier: "solo", billableMinutes: 600, remainingMinutes: 0, atCeiling: true, pendingCancel: false, cancelAt: null, allows4k: false } },

  // RULING: flexible billing sets cancel_at and leaves cape FALSE; pendingCancel
  // must still be TRUE. The regression that shipped invisible before migration
  // 20260707020000 + the reflect cancel_at capture.
  { name: "4: Studio active, cape=FALSE but cancel_at SET (flexible billing)",
    subStatus: "active", subTier: "studio", usedEncodeMinutes: 1000, grandfatheredFloorMinutes: 0,
    cancel_at: "2026-08-01T00:00:00.000Z", cancel_at_period_end: false,
    expect: { tier: "studio", billableMinutes: 1000, remainingMinutes: 1400, atCeiling: false, pendingCancel: true, cancelAt: "2026-08-01T00:00:00.000Z", allows4k: true } },

  { name: "5: Solo active, legacy cape=TRUE, cancel_at null",
    subStatus: "active", subTier: "solo", usedEncodeMinutes: 120, grandfatheredFloorMinutes: 0,
    cancel_at: null, cancel_at_period_end: true,
    expect: { tier: "solo", billableMinutes: 120, remainingMinutes: 480, atCeiling: false, pendingCancel: true, cancelAt: null, allows4k: false } },

  { name: "6: Solo active, grandfather floor subtracts (used>floor)",
    subStatus: "active", subTier: "solo", usedEncodeMinutes: 500, grandfatheredFloorMinutes: 200,
    cancel_at: null, cancel_at_period_end: false,
    expect: { tier: "solo", billableMinutes: 300, remainingMinutes: 300, atCeiling: false, pendingCancel: false, cancelAt: null, allows4k: false } },

  // RULING: grandfather floor >= used → billable clamps to 0 (never negative).
  { name: "7: Free, grandfather floor >= used → billable clamps to 0",
    subStatus: "none", subTier: null, usedEncodeMinutes: 100, grandfatheredFloorMinutes: 500,
    cancel_at: null, cancel_at_period_end: false,
    expect: { tier: "free", billableMinutes: 0, remainingMinutes: 120, atCeiling: false, pendingCancel: false, cancelAt: null, allows4k: false } },

  { name: "8: Pro active, over ceiling (soft-block) + 4K allowed",
    subStatus: "active", subTier: "pro", usedEncodeMinutes: 9500, grandfatheredFloorMinutes: 0,
    cancel_at: null, cancel_at_period_end: false,
    expect: { tier: "pro", billableMinutes: 9500, remainingMinutes: 0, atCeiling: true, pendingCancel: false, cancelAt: null, allows4k: true } },

  // RULING: a canceled sub is not returned by .in(["active","trialing"]) → tier
  // free, and its stale cancel fields must NOT leak into pendingCancel/cancelAt.
  { name: "9: Canceled sub → falls back to free; stale cancel fields ignored",
    subStatus: "canceled", subTier: "solo", usedEncodeMinutes: 50, grandfatheredFloorMinutes: 0,
    cancel_at: "2026-07-01T00:00:00.000Z", cancel_at_period_end: true,
    expect: { tier: "free", billableMinutes: 50, remainingMinutes: 70, atCeiling: false, pendingCancel: false, cancelAt: null, allows4k: false } },
];

let passed = 0;
let failed = 0;
for (const f of FIXTURES) {
  const got = derive(f) as Record<string, unknown>;
  const mismatches: string[] = [];
  for (const k of Object.keys(f.expect) as (keyof typeof f.expect)[]) {
    if (JSON.stringify(got[k]) !== JSON.stringify(f.expect[k])) {
      mismatches.push(`${k}: got ${JSON.stringify(got[k])}, want ${JSON.stringify(f.expect[k])}`);
    }
  }
  if (mismatches.length === 0) {
    passed++;
    console.log(`  PASS  ${f.name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${f.name}\n         ${mismatches.join("\n         ")}`);
  }
}
console.log(`\n  ${passed}/${FIXTURES.length} passed${failed ? ` — ${failed} FAILED` : ""}`);
process.exit(failed ? 1 : 0);
