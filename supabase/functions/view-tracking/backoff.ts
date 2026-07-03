// Pure decision helpers for view-tracking error-aware backoff (Step 1.5).
// Deno-free so it's unit-testable with tsx (like group.ts). See the ratified spec.
//
// Contract:
//   - The ladder is keyed on the DEDICATED refresh_failure_count (parse_error /
//     transient / write_failed), never view_tracking_failure_count (which stays
//     handleFailure's not_found/private death evidence).
//   - Only parse_error escalates to 'failed', and only at count >= 6. The enforced
//     ladder spacing (1h + 6h + 24h + 24h + 24h) guarantees count>=6 spans >=79h.
//   - The systemic breaker keys on TRAILING platform successes, not the broken
//     cohort's own density, so a dominant churner cohort can't shield itself.
//   - rate_limited is inert: only a short backoff, no counter, no death.

const HOUR_MS = 3_600_000;

// n=1 -> 1h, n=2 -> 6h, n>=3 -> 24h (ms).
export function ladderBackoffMs(newCount: number): number {
  if (newCount <= 1) return 1 * HOUR_MS;
  if (newCount === 2) return 6 * HOUR_MS;
  return 24 * HOUR_MS;
}

export const PARSE_DEATH_COUNT = 6;

// Death candidacy: parse_error only, at count >= 6 (>=79h span guaranteed).
export function isParseDeathCandidate(errorType: string, newCount: number): boolean {
  return errorType === "parse_error" && newCount >= PARSE_DEATH_COUNT;
}

// Trailing-success breaker. Death proceeds iff the platform shows >=5 successful
// refreshes in the trailing 24h (evidence it's healthy → the failure is per-post),
// OR the platform has < 5 active rows (small-N floor: e.g. a single twitter row
// still dies at n>=6). Otherwise suppress; suppressed candidates hold the 24h rung.
export const BREAKER_MIN_SUCCESSES_24H = 5;
export const BREAKER_SMALL_N = 5;
export function deathProceeds(successes24h: number, platformActiveCount: number): boolean {
  return (
    successes24h >= BREAKER_MIN_SUCCESSES_24H || platformActiveCount < BREAKER_SMALL_N
  );
}

// rate_limited: short, fixed backoff so the throttled row isn't first to re-hit.
export const RATE_LIMITED_BACKOFF_MS = 15 * 60_000;

// Class boundary (binding amendment): which failure counter an error type advances.
// The ladder types own refresh_failure_count; not_found/private stay on
// view_tracking_failure_count (handleFailure's death evidence); rate_limited/success
// advance neither. Documents + tests the isolation so a stray 404 can't inflate the
// parse ladder (nor a parse_error inflate the not_found/private death count).
export function failureCounterClass(
  errorType: string,
): "refresh" | "view_tracking" | "none" {
  if (
    errorType === "parse_error" ||
    errorType === "transient" ||
    errorType === "write_failed"
  ) {
    return "refresh";
  }
  if (errorType === "not_found" || errorType === "private") return "view_tracking";
  return "none";
}
