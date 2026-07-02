// Loose-CSV import path for the Letterboxd tool (client-side re-zip, "option a").
//
// Some Letterboxd users receive loose .csv files instead of the export .zip and
// hit a dead end. This module lets the CLIENT identify those files and synthesize
// a canonical Letterboxd-shaped .zip that the EXISTING server pipeline consumes
// byte-for-byte (parse.ts -> normalize.ts -> match -> preview). ZERO server
// changes: the synthetic zip is uploaded through the same presign -> PUT ->
// import-job cycle as a real export.
//
// Client-safe: no Next/Supabase imports. Reuses parseCsv/indexHeaders from
// fan-edits/csv (the SAME parser the server uses) so identification can't drift
// from parsing. Cross-lib import is relative (matches parse.ts/normalize.ts).

import { zipSync, strToU8 } from "fflate";
import { parseCsv, indexHeaders } from "../fan-edits/csv";

// Categories mirror parse.ts's RawArchive slots. "list" is the only many-per-
// import category (a user can have several lists); all others are single-slot.
export type CsvCategory =
  | "ratings"
  | "diary"
  | "reviews"
  | "watchlist"
  | "watched"
  | "likesFilms"
  | "comments"
  | "profile"
  | "list";

type BareCandidate = "watchlist" | "watched" | "likesFilms";

export type InputFile = { name: string; text: string };

export type AssignedFile = {
  category: CsvCategory;
  name: string; // original filename (unmodified, for display + manifest)
  text: string;
  rowCount: number; // data rows (excludes header / list preamble)
  note: string | null; // contradiction flag / "likes aren't imported" / dedupe note
};

export type AmbiguousFile = {
  name: string;
  text: string;
  rowCount: number;
  candidates: BareCandidate[]; // the user picks one (or Skip)
};

export type UnrecognizedFile = { name: string; reason: string };

export type CategoryConflict = {
  category: CsvCategory;
  files: Array<{ name: string; text: string; rowCount: number }>; // user picks one
};

export type IdentifyResult = {
  assigned: AssignedFile[];
  ambiguous: AmbiguousFile[];
  unrecognized: UnrecognizedFile[];
  conflicts: CategoryConflict[];
};

// ---- 1. filename canonicalization --------------------------------------------

// Strip directory path + lowercase + remove the browser/OS de-dup and copy
// suffixes that a loose-CSV user's downloads accumulate, so a hint match on the
// stem still works. Patterns handled (applied repeatedly, before the extension):
//   - " (1)", " (2)", … "(12)"      browser re-download de-dup (Chrome/Firefox)
//   - " - copy", " - Copy (2)"       Windows Explorer duplicate
//   - " copy", " copy 2"             macOS Finder duplicate
// e.g. "Letterboxd/Ratings (1).csv" -> "ratings.csv";
//      "watchlist - Copy.csv" -> "watchlist.csv";
//      "films copy 2.csv" -> "films.csv".
export function canonicalizeFilename(name: string): string {
  const base = name
    .replace(/^.*[\\/]/, "") // strip any posix/windows directory path
    .toLowerCase()
    .trim();
  const extMatch = base.match(/(\.[a-z0-9]+)$/);
  const ext = extMatch ? extMatch[1] : "";
  let stem = ext ? base.slice(0, -ext.length) : base;

  let prev: string;
  do {
    prev = stem;
    stem = stem
      .replace(/\s*\(\d+\)\s*$/, "") // " (1)"
      .replace(/\s*[-–]\s*copy(?:\s*\(\d+\))?\s*$/i, "") // " - copy", " - copy (2)"
      .replace(/\s+copy(?:\s*\d+)?\s*$/i, "") // " copy", " copy 2"
      .trim();
  } while (stem !== prev);

  return `${stem}${ext}`;
}

// ---- 2. identification -------------------------------------------------------

function firstCell(row: string[]): string {
  return (row[0] ?? "").trim().toLowerCase();
}

// A Letterboxd list CSV carries a version-marker first line ("Letterboxd list
// export vN") AND a data-table header row whose first cell is "Position" — the
// exact structure splitListPreamble (parse.ts) relies on. Either signal alone is
// decisive; a normal category CSV has neither.
function isListRows(rows: string[][]): boolean {
  const marker = firstCell(rows[0] ?? []).startsWith("letterboxd list export");
  const hasPositionHeader = rows.some((r) => firstCell(r) === "position");
  return marker || hasPositionHeader;
}

function listDataRowCount(rows: string[][]): number {
  const idx = rows.findIndex((r) => firstCell(r) === "position");
  return idx === -1 ? 0 : Math.max(0, rows.length - (idx + 1));
}

type Signature = "reviews" | "diary" | "ratings" | "bare" | null;

// Header-based signature — position-independent, order-independent, identical to
// how normalize.ts reads columns (getCol by lowercased header name). Ordered
// most-specific first: reviews contains rating+rewatch too, so "review" must win
// before diary/ratings; the bare set {name,year,date,letterboxd uri} is shared by
// watchlist/watched/likes and is therefore ambiguous by header alone.
function signatureOf(h: Record<string, number>): Signature {
  const has = (c: string) => c in h;
  const filmish = has("name") && has("letterboxd uri");
  if (!filmish) return null;
  if (has("review")) return "reviews";
  if (has("rewatch") || has("watched date")) return "diary";
  if (has("rating")) return "ratings";
  return "bare";
}

// Filename hint (substring on the canonicalized stem). Used to (a) resolve the
// bare/ambiguous set and (b) cross-check an unambiguous header signature.
// watchlist is checked before watched (neither is a substring of the other, but
// keep it explicit).
function filenameHint(canon: string): CsvCategory | null {
  if (canon.includes("watchlist")) return "watchlist";
  if (canon.includes("watched")) return "watched";
  if (canon.includes("likes") || canon.includes("films")) return "likesFilms";
  if (canon.includes("ratings")) return "ratings";
  if (canon.includes("diary")) return "diary";
  if (canon.includes("reviews")) return "reviews";
  if (canon.includes("profile")) return "profile";
  if (canon.includes("comments")) return "comments";
  return null;
}

function dataRowCount(rows: string[][]): number {
  return rows.length > 1 ? rows.length - 1 : 0;
}

type Classified =
  | { kind: "resolved"; category: CsvCategory; file: InputFile; rowCount: number; note: string | null }
  | { kind: "ambiguous"; file: InputFile; rowCount: number; candidates: BareCandidate[] }
  | { kind: "unrecognized"; file: InputFile; reason: string };

function classify(file: InputFile): Classified {
  const rows = parseCsv(file.text);
  if (rows.length === 0) {
    return { kind: "unrecognized", file, reason: "empty file" };
  }

  if (isListRows(rows)) {
    return {
      kind: "resolved",
      category: "list",
      file,
      rowCount: listDataRowCount(rows),
      note: null,
    };
  }

  const h = indexHeaders(rows[0]);
  const sig = signatureOf(h);
  const canon = canonicalizeFilename(file.name);
  const hint = filenameHint(canon);
  const rc = dataRowCount(rows);

  // Unambiguous header signatures. The filename must AGREE; on contradiction the
  // header wins (contents are ground truth) and we flag it.
  if (sig === "reviews" || sig === "diary" || sig === "ratings") {
    let note: string | null = null;
    if (hint && hint !== sig && hint !== "profile" && hint !== "comments") {
      note = `Filename looked like ${hint}, but the columns are ${sig} — using ${sig}.`;
    }
    return { kind: "resolved", category: sig, file, rowCount: rc, note };
  }

  // Bare {date,name,year,letterboxd uri}: watchlist | watched | likes-films.
  // Resolve by filename hint; otherwise defer to the user.
  if (sig === "bare") {
    if (hint === "watchlist") return { kind: "resolved", category: "watchlist", file, rowCount: rc, note: null };
    if (hint === "watched") return { kind: "resolved", category: "watched", file, rowCount: rc, note: null };
    if (hint === "likesFilms") {
      return {
        kind: "resolved",
        category: "likesFilms",
        file,
        rowCount: rc,
        note: "Likes aren't imported — this file is included for parity but skipped.",
      };
    }
    return { kind: "ambiguous", file, rowCount: rc, candidates: ["watchlist", "watched", "likesFilms"] };
  }

  // No film signature: profile.csv / comments.csv are name-identified (the server
  // extracts and only counts them — zero behavior delta vs a real zip).
  if (hint === "profile") return { kind: "resolved", category: "profile", file, rowCount: rc, note: null };
  if (hint === "comments") return { kind: "resolved", category: "comments", file, rowCount: rc, note: null };

  return { kind: "unrecognized", file, reason: "not a recognized Letterboxd export file" };
}

export function identifyCsvFiles(files: InputFile[]): IdentifyResult {
  const resolved: Array<Extract<Classified, { kind: "resolved" }>> = [];
  const ambiguous: AmbiguousFile[] = [];
  const unrecognized: UnrecognizedFile[] = [];

  for (const file of files) {
    const c = classify(file);
    if (c.kind === "resolved") resolved.push(c);
    else if (c.kind === "ambiguous")
      ambiguous.push({ name: file.name, text: file.text, rowCount: c.rowCount, candidates: c.candidates });
    else unrecognized.push({ name: file.name, reason: c.reason });
  }

  // Aggregate by category. "list" is many-per-import — never a conflict. Every
  // other category is single-slot: identical-content duplicates dedupe silently;
  // genuinely different files become a conflict for the user to resolve.
  const byCat = new Map<CsvCategory, Array<Extract<Classified, { kind: "resolved" }>>>();
  for (const r of resolved) {
    const arr = byCat.get(r.category) ?? [];
    arr.push(r);
    byCat.set(r.category, arr);
  }

  const assigned: AssignedFile[] = [];
  const conflicts: CategoryConflict[] = [];

  for (const [category, arr] of byCat) {
    if (category === "list") {
      for (const r of arr) assigned.push({ category, name: r.file.name, text: r.file.text, rowCount: r.rowCount, note: r.note });
      continue;
    }
    const distinct: Array<Extract<Classified, { kind: "resolved" }>> = [];
    for (const r of arr) {
      if (!distinct.some((d) => d.file.text === r.file.text)) distinct.push(r);
    }
    if (distinct.length === 1) {
      const r = distinct[0];
      const deduped = arr.length - 1; // identical copies that collapsed
      const note =
        deduped > 0
          ? [r.note, `${deduped} identical copy${deduped === 1 ? "" : "ies"} ignored`].filter(Boolean).join("; ")
          : r.note;
      assigned.push({ category, name: r.file.name, text: r.file.text, rowCount: r.rowCount, note: note || null });
    } else {
      conflicts.push({
        category,
        files: distinct.map((d) => ({ name: d.file.name, text: d.file.text, rowCount: d.rowCount })),
      });
    }
  }

  return { assigned, ambiguous, unrecognized, conflicts };
}

// ---- 3. synthetic zip --------------------------------------------------------

// Canonical top-level member names, matching parse.ts's exact-name lookups.
const CANONICAL_NAME: Record<Exclude<CsvCategory, "list">, string> = {
  ratings: "ratings.csv",
  diary: "diary.csv",
  reviews: "reviews.csv",
  watchlist: "watchlist.csv",
  watched: "watched.csv",
  likesFilms: "likes/films.csv",
  comments: "comments.csv",
  profile: "profile.csv",
};

function sanitizeListSlug(name: string): string {
  const stem = name
    .replace(/^.*[\\/]/, "")
    .replace(/\.csv$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return stem || "list";
}

export type ZipAssignment = { category: CsvCategory; name: string; text: string };

// Synthesize the export-shaped zip. Members use canonical names; list files land
// under lists/<sanitized-original>.csv (uniquified on slug collision). A non-CSV
// manifest member records the original filenames for R2 forensics.
//
// SAFETY of the manifest: parse.ts's unzip filter is `/\.csv$/i.test(file.name)`,
// so a .txt member is NEVER inflated, never appears in `members`, and is never
// reached by exact("ratings.csv")-style lookups or the ^lists/.+\.csv$ list
// regex. It is inert — verified round-trip in csv-select.test.ts by feeding a
// synthesized zip through the real parseLetterboxdArchive.
export function buildSyntheticZip(assignments: ZipAssignment[]): Uint8Array {
  const members: Record<string, Uint8Array> = {};
  const manifest: string[] = [];
  const usedListSlugs = new Set<string>();

  for (const a of assignments) {
    if (a.category === "list") {
      const slugBase = sanitizeListSlug(a.name);
      let slug = slugBase;
      let n = 2;
      while (usedListSlugs.has(slug)) slug = `${slugBase}-${n++}`;
      usedListSlugs.add(slug);
      const member = `lists/${slug}.csv`;
      members[member] = strToU8(a.text);
      manifest.push(`${member}  <=  ${a.name}`);
    } else {
      const member = CANONICAL_NAME[a.category];
      members[member] = strToU8(a.text);
      manifest.push(`${member}  <=  ${a.name}`);
    }
  }

  members["moonbeem-csv-import.txt"] = strToU8(
    `Moonbeem loose-CSV import — synthesized from ${assignments.length} file(s).\n` +
      `member  <=  original filename\n` +
      manifest.join("\n") +
      "\n",
  );

  return zipSync(members);
}
