// Phase 2B — Letterboxd ZIP -> routed, structurally-split raw CSV rows.
//
// Pure function (no Next/Supabase imports) so it is importable by BOTH the
// import route and the dev gate script (scripts/dev/parse-fixture.mjs, run via
// tsx). Cross-lib imports are RELATIVE (not the @/ alias) so the node/tsx dev
// script resolves them without tsconfig-path support.
//
// Unzips with fflate and parses each CSV with the shared parseCsv, which
// already handles quoted fields containing EMBEDDED NEWLINES (the list
// Description fields span physical lines) — verified in csv.ts: inside a quoted
// field a \n/\r is appended to the field, not treated as a row break.

import { unzipSync, strFromU8 } from "fflate";
import { parseCsv } from "../fan-edits/csv";

// A single lists/<slug>.csv after splitting its 3-part preamble (the blocks are
// located by CONTENT, not fixed line offsets, so exact blank placement is not
// relied upon). Real layout:
//   line 1:  Letterboxd list export v7        (version marker)
//   metaHeader: Date,Name,Tags,URL,Description (the list's own attributes)
//   metaRow:    <one values row>
//   (blank)
//   dataHeader: Position,Name,Year,URL,Description
//   dataRows:   the films
export type RawList = {
  fileSlug: string;
  metaHeader: string[] | null;
  metaRow: string[] | null;
  dataHeader: string[] | null;
  dataRows: string[][];
};

export type RawArchive = {
  members: string[];
  // in-scope category tables — rows[0] is the header; null when the member is
  // absent (tolerated).
  ratings: string[][] | null;
  diary: string[][] | null;
  reviews: string[][] | null;
  watchlist: string[][] | null;
  lists: RawList[];
  // skipped-but-counted categories.
  watched: string[][] | null;
  likesFilms: string[][] | null;
  comments: string[][] | null;
  profile: string[][] | null;
};

function firstCell(row: string[]): string {
  return (row[0] ?? "").trim().toLowerCase();
}

// Split a parsed list CSV into its metadata block + the real item table. The
// blank separator lines are already dropped by parseCsv, so the rows are
// contiguous: [marker], [metaHeader], [metaRow], [dataHeader], [items...].
// Tolerates older exports missing the metadata block or the item table.
function splitListPreamble(name: string, rows: string[][]): RawList {
  const fileSlug = name.replace(/^lists\//i, "").replace(/\.csv$/i, "");
  const dataHeaderIdx = rows.findIndex((r) => firstCell(r) === "position");
  const metaHeaderIdx = rows.findIndex((r) => firstCell(r) === "date");

  let metaHeader: string[] | null = null;
  let metaRow: string[] | null = null;
  if (
    metaHeaderIdx !== -1 &&
    (dataHeaderIdx === -1 || metaHeaderIdx < dataHeaderIdx)
  ) {
    metaHeader = rows[metaHeaderIdx];
    const cand = rows[metaHeaderIdx + 1];
    if (cand && (dataHeaderIdx === -1 || metaHeaderIdx + 1 < dataHeaderIdx)) {
      metaRow = cand;
    }
  }

  const dataHeader = dataHeaderIdx !== -1 ? rows[dataHeaderIdx] : null;
  const dataRows = dataHeaderIdx !== -1 ? rows.slice(dataHeaderIdx + 1) : [];
  return { fileSlug, metaHeader, metaRow, dataHeader, dataRows };
}

// Defense-in-depth against a decompression bomb: the compressed input is bounded
// to 25 MB upstream, but a small zip can inflate to gigabytes. The fflate filter
// runs per entry BEFORE inflation, so we (a) only inflate .csv members (every
// member we route is a CSV) and (b) cap the declared uncompressed total. The
// compressed cap remains the hard backstop for a member with a spoofed header.
const MAX_UNCOMPRESSED_BYTES = 200 * 1024 * 1024;

export function parseLetterboxdArchive(bytes: Uint8Array): RawArchive {
  let declaredTotal = 0;
  const files = unzipSync(bytes, {
    filter: (file) => {
      declaredTotal += file.originalSize;
      if (declaredTotal > MAX_UNCOMPRESSED_BYTES) {
        throw new Error("letterboxd archive exceeds uncompressed size limit");
      }
      return /\.csv$/i.test(file.name);
    },
  });
  const members = Object.keys(files).sort();

  const decode = (name: string): string[][] | null => {
    const u8 = files[name];
    if (!u8) return null;
    const rows = parseCsv(strFromU8(u8));
    return rows.length ? rows : null;
  };
  // Only EXACT top-level member names are routed. The deleted/ and orphaned/
  // subdirs (deleted/diary.csv, orphaned/reviews.csv, ...) are intentionally
  // ignored — they are out of scope for the import.
  const exact = (name: string): string[][] | null =>
    members.includes(name) ? decode(name) : null;

  const lists: RawList[] = members
    .filter((n) => /^lists\/[^/]+\.csv$/i.test(n))
    .map((n) => splitListPreamble(n, decode(n) ?? []));

  return {
    members,
    ratings: exact("ratings.csv"),
    diary: exact("diary.csv"),
    reviews: exact("reviews.csv"),
    watchlist: exact("watchlist.csv"),
    lists,
    watched: exact("watched.csv"),
    likesFilms: exact("likes/films.csv"),
    comments: exact("comments.csv"),
    profile: exact("profile.csv"),
  };
}
