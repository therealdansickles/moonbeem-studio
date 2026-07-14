// Unit tests for the territory gate — the fail-closed rules are the whole point,
// so they get pinned. Run: npx tsx src/lib/playback/territory.test.ts
//
// Only testable because C1 made isTerritoryAllowed PURE (it used to do its own
// DB read). Every case below encodes a rule the route depends on for a 451.

import { isTerritoryAllowed, type TerritoryRights } from "./territory";

let failures = 0;
function check(name: string, got: boolean, want: boolean) {
  if (got === want) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.error(`  FAIL ${name} — got ${got}, want ${want}`);
  }
}

const worldwide: TerritoryRights = {
  territory_worldwide: true,
  allowed_territories: null,
};
const usOnly: TerritoryRights = {
  territory_worldwide: false,
  allowed_territories: ["US"],
};
const unset: TerritoryRights = {
  territory_worldwide: false,
  allowed_territories: null,
};
const unsetEmptyList: TerritoryRights = {
  territory_worldwide: false,
  allowed_territories: [],
};

console.log("territory gate");

// Missing / soft-deleted title -> DENY (never allow-all on a missing rights row).
check("null rights denies (fail-closed)", isTerritoryAllowed("US", null), false);
check("null rights denies even w/ null country", isTerritoryAllowed(null, null), false);

// Worldwide -> allow regardless of (or without) a country.
check("worldwide allows a known country", isTerritoryAllowed("US", worldwide), true);
check("worldwide allows an UNKNOWN country", isTerritoryAllowed(null, worldwide), true);

// Allow-list.
check("in-list country allows", isTerritoryAllowed("US", usOnly), true);
check("out-of-list country denies", isTerritoryAllowed("CA", usOnly), false);
check("case-insensitive match allows", isTerritoryAllowed("us", usOnly), true);

// THE LOAD-BEARING ONE: unknown country against a RESTRICTED title -> DENY.
// (Apple Private Relay / VPN traffic omits x-vercel-ip-country. We prefer a lost
// play over an out-of-territory one.)
check("unknown country vs restricted DENIES", isTerritoryAllowed(null, usOnly), false);

// Unset rights (no worldwide, no list) -> default-deny. Two prod titles are in
// exactly this state today ("Going Dry", "Georgia O'Keeffe").
check("unset (null list) default-denies", isTerritoryAllowed("US", unset), false);
check("unset (empty list) default-denies", isTerritoryAllowed("US", unsetEmptyList), false);

if (failures > 0) {
  console.error(`\n${failures} FAILURE(S)`);
  process.exit(1);
}
console.log("\nall territory tests passed");
