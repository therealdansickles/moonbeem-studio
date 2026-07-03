// ED-unit budget guard for scrapes (step 2, ruling X — 2026-07-03).
//
// The shared daily meter is EnsembleData's own /customer/get-used-units (see
// ensembledata.ts::getUsedUnits) — the billing truth for the token, which
// view-tracking and the scraper share, so it already counts BOTH spend paths
// including failed-but-charged calls. This module is the PURE decision layer on
// top of that reading; the impure meter read + env read live in the caller
// (scrapeSourceAccount).
//
// INVARIANT (ratified): scrapes — and ONLY scrapes — abort on units.
// view-tracking never consults this; it is wall-clock bounded only.
//
// "Scrapes cannot starve view-tracking": the ceiling reserves view-tracking's
// REMAINING-day spend, estimated at VT_DAILY_ESTIMATE units/day pro-rated by the
// hours left in the UTC day, so early-day scrapes hold back more.
//
// FAIL-CLOSED: if the meter can't be read, a scrape is refused (never spends
// blind). The three constants default in code (so the guard is ARMED on deploy
// without a Vercel env change) and are env-overridable.

export type BudgetConfig = {
  budget: number; // ENSEMBLEDATA_DAILY_UNIT_BUDGET
  cutoffPct: number; // ENSEMBLEDATA_SCRAPE_CUTOFF_PCT (0..1)
  vtDailyEstimate: number; // ENSEMBLEDATA_VIEW_TRACKING_DAILY_ESTIMATE
};

export const DEFAULT_BUDGET = 4000;
export const DEFAULT_CUTOFF_PCT = 0.85;
export const DEFAULT_VT_DAILY_ESTIMATE = 1200;

function num(v: string | undefined, dflt: number): number {
  if (v == null || v.trim() === "") return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

// Read the three env-tunable constants with ratified defaults. Defaults are the
// operative values — the guard is live at 4000/0.85/1200 on deploy; set the envs
// only to override (Vercel; takes effect on the next deployment).
export function resolveBudgetConfig(
  env: Record<string, string | undefined> = process.env,
): BudgetConfig {
  return {
    budget: num(env.ENSEMBLEDATA_DAILY_UNIT_BUDGET, DEFAULT_BUDGET),
    cutoffPct: num(env.ENSEMBLEDATA_SCRAPE_CUTOFF_PCT, DEFAULT_CUTOFF_PCT),
    vtDailyEstimate: num(
      env.ENSEMBLEDATA_VIEW_TRACKING_DAILY_ESTIMATE,
      DEFAULT_VT_DAILY_ESTIMATE,
    ),
  };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

// Next UTC midnight — the guaranteed meter reset (get-used-units is per-UTC-day).
export function nextUtcMidnight(now: Date): Date {
  return new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + 1,
      0,
      0,
      0,
      0,
    ),
  );
}

// Fractional hours left in the current UTC day (0..24]; 24 at 00:00 UTC.
export function hoursRemainingInUtcDay(now: Date): number {
  return (nextUtcMidnight(now).getTime() - now.getTime()) / 3_600_000;
}

// Worst-case units a scrape could spend: ~10/page over depth*calls pages, + ~10
// resolve/overhead. Deliberately the CEILING (a typical incremental spends ~10),
// so the guard reserves conservatively.
export function projectedUnits(pageDepth: number, maxCalls: number): number {
  const maxPages =
    Math.max(1, Math.floor(pageDepth)) * Math.max(1, Math.floor(maxCalls));
  return maxPages * 10 + 10;
}

export type BudgetReason = "ok" | "soft_cap" | "vt_reservation" | "meter_unavailable";

export type BudgetDecision = {
  allow: boolean;
  reason: BudgetReason;
  budget: number;
  cutoffPct: number;
  vtDailyEstimate: number;
  unitsToday: number | null; // null = meter read failed
  projected: number;
  reservedVt: number;
  softCeiling: number;
  hardCeiling: number;
  scrapeCeiling: number;
  wouldReach: number | null; // unitsToday + projected, or null when meter down
};

// Pure. Given the config, the fractional hours left in the UTC day, the meter
// reading (null when unreadable), and the projected cost, decide whether a scrape
// may proceed and label WHY.
export function scrapeBudgetDecision(input: {
  config: BudgetConfig;
  hoursRemaining: number;
  unitsToday: number | null;
  projected: number;
}): BudgetDecision {
  const { budget, cutoffPct, vtDailyEstimate } = input.config;
  const reservedVt = Math.round(
    (vtDailyEstimate * clamp(input.hoursRemaining, 0, 24)) / 24,
  );
  const softCeiling = Math.floor(budget * clamp(cutoffPct, 0, 1));
  const hardCeiling = budget - reservedVt;
  const scrapeCeiling = Math.min(softCeiling, hardCeiling);

  const base = {
    budget,
    cutoffPct,
    vtDailyEstimate,
    projected: input.projected,
    reservedVt,
    softCeiling,
    hardCeiling,
    scrapeCeiling,
  };

  // Fail-closed: meter unreadable -> refuse (never spend blind).
  if (input.unitsToday === null) {
    return {
      ...base,
      allow: false,
      reason: "meter_unavailable",
      unitsToday: null,
      wouldReach: null,
    };
  }

  const wouldReach = input.unitsToday + input.projected;
  const allow = wouldReach <= scrapeCeiling;
  const reason: BudgetReason = allow
    ? "ok"
    : hardCeiling < softCeiling
      ? "vt_reservation" // view-tracking's pro-rated reservation is the binding cap
      : "soft_cap"; // the flat cutoff % is the binding cap
  return { ...base, allow, reason, unitsToday: input.unitsToday, wouldReach };
}

// One-line, labeled human summary for the never-silent abort (admin message + cron
// log). Includes the binding bound, meter reading, projected, ceiling, and the
// retry horizon (next UTC midnight resets the meter).
export function describeBudgetAbort(d: BudgetDecision, retryAfterUtc: string): string {
  if (d.reason === "meter_unavailable") {
    return `Scrape held — EnsembleData unit meter unreadable, so the budget guard fails closed (no blind spend). Retry after the meter is reachable; the daily budget resets ${retryAfterUtc}.`;
  }
  const bound =
    d.reason === "vt_reservation"
      ? `view-tracking reservation (${d.reservedVt} units held for the rest of today)`
      : `${Math.round(d.cutoffPct * 100)}% daily cutoff`;
  return `Scrape held — ${d.unitsToday}/${d.budget} units used today, this run projects ~${d.projected} more, which would reach ${d.wouldReach} over the ${d.scrapeCeiling}-unit ceiling (bound: ${bound}). view-tracking is never blocked. Budget resets ${retryAfterUtc}.`;
}
