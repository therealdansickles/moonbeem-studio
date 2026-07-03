// Pure classification for the buyer Library (v1). Turns the flat getMyEntitlements
// list into the two rendered sections, applying:
//   - Q7#3 precedence: ONE row per title, purchase > active rental > expired rental
//     (refunded ranks lowest, so a re-purchase/re-rent supersedes it).
//   - the state each surviving row displays: owned / refunded / active / expired.
//   - the 90-day collapse: inactive rentals whose expiry/refund is older than
//     EXPIRED_COLLAPSE_DAYS fold under a show-more affordance.
// No DB, no dates-from-outside beyond the injected `now` — unit-testable.

import { isEntitlementActive, entitlementExpiresAt } from "./window";
import type { LibraryEntitlement, LibraryTitle } from "./lookup";

// Inactive rentals (expired or refunded) older than this collapse under show-more.
// A constant in code (not env) — a display threshold, not an operational knob.
export const EXPIRED_COLLAPSE_DAYS = 90;

const DAY_MS = 86_400_000;

export type LibraryItemState = "owned" | "refunded" | "active" | "expired";

export type LibraryItem = {
  entitlementId: string;
  title: LibraryTitle;
  kind: string; // 'purchase' | 'rental'
  state: LibraryItemState;
  purchasedAt: string;
  pricePaidCents: number;
  firstPlayedAt: string | null; // drives the two expired-copy flavors
  expiresAt: string | null; // ISO; null for a purchase
  refundedAt: string | null; // ISO revoked_at when state === 'refunded'
};

// Precedence rank for picking one row per title. Higher wins.
function rank(e: LibraryEntitlement, now: Date): number {
  if (e.revoked_at != null) return 1; // refunded — a live re-buy/re-rent beats it
  if (e.kind === "purchase") return 5; // owned, permanent
  return isEntitlementActive(e, now) ? 4 : 3; // active rental > expired rental
}

function toItem(e: LibraryEntitlement, now: Date): LibraryItem {
  let state: LibraryItemState;
  if (e.revoked_at != null) state = "refunded";
  else if (e.kind === "purchase") state = "owned";
  else state = isEntitlementActive(e, now) ? "active" : "expired";
  const expiry = entitlementExpiresAt(e);
  return {
    entitlementId: e.id,
    title: e.title,
    kind: e.kind,
    state,
    purchasedAt: e.purchased_at,
    pricePaidCents: e.price_paid_cents,
    firstPlayedAt: e.first_played_at,
    expiresAt: expiry ? expiry.toISOString() : null,
    refundedAt: e.revoked_at,
  };
}

export type ClassifiedLibrary = {
  purchases: LibraryItem[]; // kind purchase (owned or refunded), newest first
  rentalsActive: LibraryItem[]; // soonest-expiring first
  rentalsInactiveRecent: LibraryItem[]; // expired/refunded within the window, newest first
  rentalsInactiveOlder: LibraryItem[]; // expired/refunded older than the window (collapsed)
};

export function classifyLibrary(
  entitlements: LibraryEntitlement[],
  now: Date = new Date(),
): ClassifiedLibrary {
  // 1. One row per title — highest precedence wins. Input is purchased_at DESC, so
  //    on a rank tie the first-seen (most recent) row is kept.
  const bestByTitle = new Map<string, LibraryEntitlement>();
  for (const e of entitlements) {
    const cur = bestByTitle.get(e.title.id);
    if (!cur || rank(e, now) > rank(cur, now)) bestByTitle.set(e.title.id, e);
  }
  const items = Array.from(bestByTitle.values()).map((e) => toItem(e, now));

  const purchases = items
    .filter((i) => i.kind === "purchase")
    .sort((a, b) => b.purchasedAt.localeCompare(a.purchasedAt));

  const rentals = items.filter((i) => i.kind === "rental");
  const rentalsActive = rentals
    .filter((i) => i.state === "active")
    .sort((a, b) => (a.expiresAt ?? "").localeCompare(b.expiresAt ?? "")); // soonest first

  // Inactive = expired + refunded, keyed for age by whichever timestamp ended access.
  const refTime = (i: LibraryItem): number => {
    const iso = i.state === "refunded" ? i.refundedAt : i.expiresAt;
    return iso ? new Date(iso).getTime() : 0;
  };
  const inactive = rentals
    .filter((i) => i.state === "expired" || i.state === "refunded")
    .sort((a, b) => refTime(b) - refTime(a)); // most-recent first
  const cutoff = now.getTime() - EXPIRED_COLLAPSE_DAYS * DAY_MS;
  const rentalsInactiveRecent = inactive.filter((i) => refTime(i) >= cutoff);
  const rentalsInactiveOlder = inactive.filter((i) => refTime(i) < cutoff);

  return { purchases, rentalsActive, rentalsInactiveRecent, rentalsInactiveOlder };
}

// Human "time left" for an active rental countdown (server-rendered, static). Coarse
// on purpose — v1 shows "about N days/hours left", not a live ticking clock.
export function formatTimeLeft(expiresAtIso: string, now: Date = new Date()): string {
  const ms = new Date(expiresAtIso).getTime() - now.getTime();
  if (ms <= 0) return "expiring now";
  const hours = ms / 3_600_000;
  if (hours >= 48) return `about ${Math.round(hours / 24)} days left`;
  if (hours >= 1) return `about ${Math.round(hours)} hours left`;
  return "less than an hour left";
}
