/* eslint-disable */
// Standalone assertion tests for the loose-CSV identification + zip-synthesis
// PURE logic — this repo has no test runner, so run directly:
//   npx tsx src/lib/letterboxd/csv-select.test.ts
//
// Covers the Phase-A fixture matrix: canonical names, dedup-suffixed names, a
// list file with preamble, an ambiguous bare-signature file with no hint, a
// "films (1).csv", two-ratings conflict (identical -> dedupe, differing ->
// conflict), an unrecognized CSV, an empty file. PLUS the swap guard
// (watchlist!=watched), the filename/signature contradiction flag, and a
// round-trip: buildSyntheticZip output fed through the REAL parseLetterboxdArchive
// to prove (a) the synthetic zip is consumed correctly and (b) the .txt manifest
// is inert.

import {
  canonicalizeFilename,
  identifyCsvFiles,
  buildSyntheticZip,
  type InputFile,
} from "./csv-select";
import { parseLetterboxdArchive } from "./parse";

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) {
    failures++;
    console.error(`     got  ${JSON.stringify(got)}\n     want ${JSON.stringify(want)}`);
  }
}

// ---- fixtures (header-accurate to real Letterboxd exports) -------------------

const RATINGS = `Date,Name,Year,Letterboxd URI,Rating
2024-01-01,Inception,2010,https://boxd.it/aaa,4.5
2024-01-02,Heat,1995,https://boxd.it/bbb,5`;

const RATINGS_DIFFERENT = `Date,Name,Year,Letterboxd URI,Rating
2024-02-01,Solaris,1972,https://boxd.it/ccc,4`;

const DIARY = `Date,Name,Year,Letterboxd URI,Rating,Rewatch,Tags,Watched Date
2024-01-03,Mirror,1975,https://boxd.it/ddd,5,No,,2024-01-02`;

const REVIEWS = `Date,Name,Year,Letterboxd URI,Rating,Rewatch,Tags,Watched Date,Review
2024-01-04,Stalker,1979,https://boxd.it/eee,5,No,,2024-01-03,"A masterpiece, top to bottom."`;

// watchlist / watched / likes all share this bare header — indistinguishable by
// header alone; only the filename hint separates them.
const BARE = (film: string, uri: string) => `Date,Name,Year,Letterboxd URI
2024-01-05,${film},2021,${uri}`;

const WATCHLIST = BARE("Dune", "https://boxd.it/fff");
const WATCHED = BARE("Tenet", "https://boxd.it/ggg");
const LIKES = BARE("Akira", "https://boxd.it/hhh");

const LIST = `Letterboxd list export v7
Date,Name,Tags,URL,Description
2024-01-01,My Favorites,,https://letterboxd.com/u/list/favorites/,"the best"

Position,Name,Year,URL,Description
1,Playtime,1967,https://boxd.it/iii,
2,Sans Soleil,1983,https://boxd.it/jjj,`;

const UNRECOGNIZED = `Foo,Bar,Baz
1,2,3`;

const EMPTY = ``;

const f = (name: string, text: string): InputFile => ({ name, text });

// ---- 1. canonicalizeFilename -------------------------------------------------

check("canon: plain", canonicalizeFilename("ratings.csv"), "ratings.csv");
check("canon: uppercase + path", canonicalizeFilename("Letterboxd/Ratings.csv"), "ratings.csv");
check("canon: windows path", canonicalizeFilename("C:\\dl\\Watchlist.csv"), "watchlist.csv");
check("canon: (1) dedup", canonicalizeFilename("ratings (1).csv"), "ratings.csv");
check("canon: (12) dedup", canonicalizeFilename("diary (12).csv"), "diary.csv");
check("canon: windows - Copy", canonicalizeFilename("watchlist - Copy.csv"), "watchlist.csv");
check("canon: windows - Copy (2)", canonicalizeFilename("watched - Copy (2).csv"), "watched.csv");
check("canon: macOS copy", canonicalizeFilename("films copy.csv"), "films.csv");
check("canon: macOS copy 2", canonicalizeFilename("films copy 2.csv"), "films.csv");
check("canon: stacked ' (1) - copy'", canonicalizeFilename("reviews (1) - copy.csv"), "reviews.csv");
check("canon: films (1)", canonicalizeFilename("films (1).csv"), "films.csv");

// ---- 2. identifyCsvFiles: canonical happy path ------------------------------

{
  const r = identifyCsvFiles([
    f("ratings.csv", RATINGS),
    f("diary.csv", DIARY),
    f("reviews.csv", REVIEWS),
    f("watchlist.csv", WATCHLIST),
    f("watched.csv", WATCHED),
    f("favorites.csv", LIST),
  ]);
  const cats = r.assigned.map((a) => a.category).sort();
  check(
    "identify: 6 canonical files all assigned",
    { cats, amb: r.ambiguous.length, unrec: r.unrecognized.length, conf: r.conflicts.length },
    { cats: ["diary", "list", "ratings", "reviews", "watched", "watchlist"], amb: 0, unrec: 0, conf: 0 },
  );
}

// ---- SWAP GUARD: watchlist stays watchlist, watched stays watched -----------

{
  const r = identifyCsvFiles([f("watchlist.csv", WATCHLIST), f("watched.csv", WATCHED)]);
  const wl = r.assigned.find((a) => a.category === "watchlist");
  const wd = r.assigned.find((a) => a.category === "watched");
  check("swap-guard: watchlist file -> watchlist (Dune)", wl?.text.includes("Dune"), true);
  check("swap-guard: watched file -> watched (Tenet)", wd?.text.includes("Tenet"), true);
  check("swap-guard: no crossover", [wl?.text.includes("Tenet"), wd?.text.includes("Dune")], [false, false]);
}

// dedup-suffixed hint still resolves
{
  const r = identifyCsvFiles([f("watched (1).csv", WATCHED)]);
  check("identify: 'watched (1).csv' -> watched", r.assigned[0]?.category, "watched");
}

// ---- 3. list file with preamble ---------------------------------------------

{
  const r = identifyCsvFiles([f("my-favorites.csv", LIST)]);
  check("identify: list file -> list, 2 items", { cat: r.assigned[0]?.category, rows: r.assigned[0]?.rowCount }, { cat: "list", rows: 2 });
}

// ---- 4. ambiguous bare-signature, no hint -----------------------------------

{
  const r = identifyCsvFiles([f("export-data.csv", WATCHLIST)]);
  check(
    "identify: bare + no hint -> ambiguous[]",
    { assigned: r.assigned.length, ambiguous: r.ambiguous.length, candidates: r.ambiguous[0]?.candidates },
    { assigned: 0, ambiguous: 1, candidates: ["watchlist", "watched", "likesFilms"] },
  );
}

// ---- 5. "films (1).csv" -> likesFilms with the not-imported note ------------

{
  const r = identifyCsvFiles([f("films (1).csv", LIKES)]);
  const a = r.assigned[0];
  check("identify: films(1) -> likesFilms", a?.category, "likesFilms");
  check("identify: likesFilms carries 'not imported' note", (a?.note ?? "").toLowerCase().includes("aren't imported"), true);
}

// ---- 6a. two ratings, IDENTICAL content -> silent dedupe --------------------

{
  const r = identifyCsvFiles([f("ratings.csv", RATINGS), f("ratings (1).csv", RATINGS)]);
  check(
    "identify: identical ratings pair -> 1 assigned, 0 conflicts",
    { assigned: r.assigned.length, cat: r.assigned[0]?.category, conflicts: r.conflicts.length, noteHasIgnored: (r.assigned[0]?.note ?? "").includes("ignored") },
    { assigned: 1, cat: "ratings", conflicts: 0, noteHasIgnored: true },
  );
}

// ---- 6b. two ratings, DIFFERENT content -> conflict -------------------------

{
  const r = identifyCsvFiles([f("ratings.csv", RATINGS), f("ratings-backup.csv", RATINGS_DIFFERENT)]);
  check(
    "identify: differing ratings pair -> conflict[], 0 assigned to ratings",
    { assigned: r.assigned.filter((a) => a.category === "ratings").length, conflicts: r.conflicts.length, conflictCat: r.conflicts[0]?.category, conflictFiles: r.conflicts[0]?.files.length },
    { assigned: 0, conflicts: 1, conflictCat: "ratings", conflictFiles: 2 },
  );
}

// ---- 7. unrecognized CSV ----------------------------------------------------

{
  const r = identifyCsvFiles([f("budget.csv", UNRECOGNIZED)]);
  check("identify: unrecognized -> unrecognized[]", { assigned: r.assigned.length, unrec: r.unrecognized.length, reason: r.unrecognized[0]?.reason }, { assigned: 0, unrec: 1, reason: "not a recognized Letterboxd export file" });
}

// ---- 8. empty file ----------------------------------------------------------

{
  const r = identifyCsvFiles([f("empty.csv", EMPTY)]);
  check("identify: empty file -> unrecognized(empty)", { unrec: r.unrecognized.length, reason: r.unrecognized[0]?.reason }, { unrec: 1, reason: "empty file" });
}

// ---- contradiction: filename says watchlist, columns say ratings ------------

{
  const r = identifyCsvFiles([f("watchlist.csv", RATINGS)]); // has Rating column
  const a = r.assigned[0];
  check("contradiction: watchlist-named + rating columns -> ratings (trust signature)", a?.category, "ratings");
  check("contradiction: flagged with a note", (a?.note ?? "").length > 0, true);
}

// ---- round-trip: synthetic zip -> REAL parseLetterboxdArchive ---------------
// Proves the synthesized zip is consumed byte-for-byte by the server parser AND
// that the .txt manifest is inert (never appears in members / never routed).

{
  const r = identifyCsvFiles([
    f("ratings.csv", RATINGS),
    f("diary.csv", DIARY),
    f("watchlist.csv", WATCHLIST),
    f("watched.csv", WATCHED),
    f("favorites.csv", LIST),
    f("films.csv", LIKES),
  ]);
  const zip = buildSyntheticZip(r.assigned.map((a) => ({ category: a.category, name: a.name, text: a.text })));
  const archive = parseLetterboxdArchive(zip);

  check("roundtrip: ratings routed (2 data rows)", archive.ratings ? archive.ratings.length - 1 : null, 2);
  check("roundtrip: diary routed (1 data row)", archive.diary ? archive.diary.length - 1 : null, 1);
  check("roundtrip: watchlist routed = Dune", archive.watchlist?.[1]?.join(",").includes("Dune"), true);
  check("roundtrip: watched routed = Tenet", archive.watched?.[1]?.join(",").includes("Tenet"), true);
  check("roundtrip: likes/films routed (1 data row)", archive.likesFilms ? archive.likesFilms.length - 1 : null, 1);
  check("roundtrip: 1 list, 2 items", { lists: archive.lists.length, items: archive.lists[0]?.dataRows.length }, { lists: 1, items: 2 });
  check("roundtrip: manifest .txt is NOT a routed member", archive.members.some((m) => m.endsWith(".txt")), false);
  check("roundtrip: reviews absent (not supplied) -> null (partial import ok)", archive.reviews, null);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
