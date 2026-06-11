// Phase 2B parser gate — run with: npx tsx scripts/dev/parse-fixture.mjs
//
// Reads the gitignored local Letterboxd export (fixtures/letterboxd/*.zip) and
// exercises the REAL parser + normalizer (no reimplementation). GATE: the
// per-category counts must equal the 2B fixture inventory exactly; any drift is
// a parser bug. Prints counts + warning count only (no personal row contents).

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseLetterboxdArchive } from "../../src/lib/letterboxd/parse.ts";
import { normalizeArchive } from "../../src/lib/letterboxd/normalize.ts";

const DIR = "fixtures/letterboxd";

const zips = readdirSync(DIR).filter((f) => f.toLowerCase().endsWith(".zip"));
if (zips.length !== 1) {
  console.error(`expected exactly 1 zip under ${DIR}, found ${zips.length}`);
  process.exit(2);
}

const bytes = new Uint8Array(readFileSync(join(DIR, zips[0])));
const archive = parseLetterboxdArchive(bytes);
const n = normalizeArchive(archive);

const listItems = n.lists.map((l) => l.items.length);
console.log("zip:        ", zips[0]);
console.log("ratings:    ", n.ratings.length);
console.log("diary:      ", n.diary.length);
console.log("reviews:    ", n.reviews.length);
console.log("watchlist:  ", n.watchlist.length);
console.log("lists:      ", n.lists.length, "items:", listItems.join("/"));
console.log("skipped:    ", JSON.stringify(n.skipped));
console.log("warnings:   ", n.warnings.length);

const EXPECTED = {
  ratings: 243,
  diary: 5,
  reviews: 0,
  watchlist: 202,
  lists: 5,
  items: [3, 52, 58, 163, 259], // inventory order; compared as a sorted multiset
};
const sortNum = (a, b) => a - b;
const gotItems = [...listItems].sort(sortNum);
const expItems = [...EXPECTED.items].sort(sortNum);
const pass =
  n.ratings.length === EXPECTED.ratings &&
  n.diary.length === EXPECTED.diary &&
  n.reviews.length === EXPECTED.reviews &&
  n.watchlist.length === EXPECTED.watchlist &&
  n.lists.length === EXPECTED.lists &&
  JSON.stringify(gotItems) === JSON.stringify(expItems);

console.log(pass ? "GATE PASS ✅" : "GATE FAIL ❌  (counts must equal the inventory)");
process.exit(pass ? 0 : 1);
