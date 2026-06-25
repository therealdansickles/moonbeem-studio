// Rental two-clock validity (the iTunes/Amazon model). A rental is ACTIVE while:
//   - it has NOT been started AND is within START_WINDOW_DAYS of purchase, OR
//   - it HAS been started AND is within PLAY_WINDOW_HOURS of first play.
// Purchases never expire. The window rule lives HERE (one place): transactions
// sub-unit 2 uses it for the charge-init double-pay guard; sub-unit 3's playback
// gate will reuse the same function so the two can never disagree.

export const RENTAL_START_WINDOW_DAYS = 30; // days from purchase to BEGIN watching
export const RENTAL_PLAY_WINDOW_HOURS = 48; // hours from first play to FINISH

export type EntitlementWindowRow = {
  kind: string;
  purchased_at: string; // ISO timestamptz
  first_played_at: string | null;
};

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

export function isEntitlementActive(
  e: EntitlementWindowRow,
  now: Date = new Date(),
): boolean {
  if (e.kind === "purchase") return true; // permanent ownership

  const nowMs = now.getTime();
  if (e.first_played_at) {
    // Started: 48h from first play to finish.
    const startedMs = new Date(e.first_played_at).getTime();
    return nowMs < startedMs + RENTAL_PLAY_WINDOW_HOURS * HOUR_MS;
  }
  // Not yet started: 30 days from purchase to begin.
  const purchasedMs = new Date(e.purchased_at).getTime();
  return nowMs < purchasedMs + RENTAL_START_WINDOW_DAYS * DAY_MS;
}
