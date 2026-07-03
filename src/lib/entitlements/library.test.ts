// Fixtures for the Library classification. Run with:
//   npx tsx src/lib/entitlements/library.test.ts
// Pure module — proves the Q7#3 precedence (one row per title), the section split,
// and the 90-day inactive collapse. Date math itself is proven in window.test.ts.

import { classifyLibrary, EXPIRED_COLLAPSE_DAYS } from "./library";
import type { LibraryEntitlement } from "./lookup";

let passed = 0;
let failed = 0;
function ok(cond: boolean, label: string) {
  if (cond) passed++;
  else {
    failed++;
    console.error(`  ✗ FAIL: ${label}`);
  }
}

const NOW = new Date("2026-07-03T12:00:00.000Z");
const DAY = 86_400_000;
const HOUR = 3_600_000;
const iso = (msAgo: number) => new Date(NOW.getTime() - msAgo).toISOString();

function title(id: string) {
  return {
    id,
    slug: `s-${id}`,
    title: `T ${id}`,
    poster_url: null,
    is_public: true,
    transact_enabled: true,
    transact_price_cents: 399,
  };
}
function row(
  titleId: string,
  kind: "purchase" | "rental",
  opts: { purchasedDaysAgo: number; playedHoursAgo?: number; revokedDaysAgo?: number },
): LibraryEntitlement {
  return {
    id: `${titleId}-${kind}-${opts.purchasedDaysAgo}`,
    kind,
    purchased_at: iso(opts.purchasedDaysAgo * DAY),
    first_played_at: opts.playedHoursAgo != null ? iso(opts.playedHoursAgo * HOUR) : null,
    price_paid_cents: 399,
    revoked_at: opts.revokedDaysAgo != null ? iso(opts.revokedDaysAgo * DAY) : null,
    title: title(titleId),
  };
}

console.log("precedence — one row per title (Q7#3):");
{
  // t1: refunded rental + owned purchase -> purchase wins, purchases section, owned
  const r = classifyLibrary(
    [
      row("t1", "rental", { purchasedDaysAgo: 10, revokedDaysAgo: 5 }),
      row("t1", "purchase", { purchasedDaysAgo: 8 }),
    ],
    NOW,
  );
  ok(r.purchases.length === 1 && r.purchases[0].state === "owned", "purchase > refunded rental -> owned in purchases");
  ok(r.rentalsActive.length === 0 && r.rentalsInactiveRecent.length === 0, "no rental card for t1 (deduped to the purchase)");
}
{
  // t2: active rental (day 5, unstarted) + expired rental (day 60) -> active wins
  const r = classifyLibrary(
    [
      row("t2", "rental", { purchasedDaysAgo: 60 }),
      row("t2", "rental", { purchasedDaysAgo: 5 }),
    ],
    NOW,
  );
  ok(r.rentalsActive.length === 1 && r.rentalsActive[0].state === "active", "active rental > expired rental");
  ok(r.rentalsInactiveRecent.length === 0 && r.rentalsInactiveOlder.length === 0, "t2 not also shown as expired");
}

console.log("section split + states:");
{
  const r = classifyLibrary(
    [
      row("p1", "purchase", { purchasedDaysAgo: 2 }), // owned
      row("a1", "rental", { purchasedDaysAgo: 3 }), // active (unstarted, day 3)
      row("e1", "rental", { purchasedDaysAgo: 40 }), // expired (30d window lapsed 10d ago) -> recent
      row("x1", "rental", { purchasedDaysAgo: 5, revokedDaysAgo: 1 }), // refunded, 1d ago -> recent
    ],
    NOW,
  );
  ok(r.purchases.length === 1 && r.purchases[0].state === "owned", "owned purchase -> purchases");
  ok(r.rentalsActive.length === 1 && r.rentalsActive[0].state === "active", "active rental -> rentalsActive");
  const recentStates = r.rentalsInactiveRecent.map((i) => i.state).sort();
  ok(JSON.stringify(recentStates) === JSON.stringify(["expired", "refunded"]), "expired + refunded -> inactiveRecent");
  ok(r.rentalsInactiveOlder.length === 0, "nothing older than 90d yet");
}

console.log(`90-day collapse (constant = ${EXPIRED_COLLAPSE_DAYS}):`);
{
  // expired 200 days ago (window lapsed ~170d ago) -> older; expired 40 days ago -> recent
  const r = classifyLibrary(
    [
      row("old", "rental", { purchasedDaysAgo: 200 }),
      row("recent", "rental", { purchasedDaysAgo: 40 }),
    ],
    NOW,
  );
  ok(r.rentalsInactiveOlder.length === 1 && r.rentalsInactiveOlder[0].title.id === "old", "expiry >90d ago -> collapsed (older)");
  ok(r.rentalsInactiveRecent.length === 1 && r.rentalsInactiveRecent[0].title.id === "recent", "expiry <=90d ago -> shown (recent)");
}

console.log("two expired flavors carried on the item (firstPlayedAt):");
{
  const r = classifyLibrary(
    [
      row("neverStarted", "rental", { purchasedDaysAgo: 40 }), // unstarted lapsed
      row("windowEnded", "rental", { purchasedDaysAgo: 10, playedHoursAgo: 72 }), // started, 48h ended
    ],
    NOW,
  );
  const byId = Object.fromEntries(r.rentalsInactiveRecent.map((i) => [i.title.id, i]));
  ok(byId["neverStarted"]?.state === "expired" && byId["neverStarted"]?.firstPlayedAt === null, "never-started expired: firstPlayedAt null");
  ok(byId["windowEnded"]?.state === "expired" && byId["windowEnded"]?.firstPlayedAt !== null, "viewing-window-ended expired: firstPlayedAt set");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
