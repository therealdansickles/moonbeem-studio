// Phase 2B — RawArchive -> normalized, typed records per category + warnings.
//
// Pure function (no Next/Supabase imports); relative cross-lib imports so the
// dev gate script can run it via tsx. external_uri assignment follows the
// carried rulings:
//   - ratings:        external_uri = the FILM URI (ratings.csv "Letterboxd URI")
//   - diary/reviews:  external_uri = the per-ENTRY permalink (rewatch-safe;
//                     diary.csv / reviews.csv "Letterboxd URI" is per-entry)
//   - watchlist item: external_uri = the FILM URI ("Letterboxd URI")
//   - list item:      external_uri = the FILM URL (lists/* data "URL")
//   - list container: external_uri = the LIST's own URL (metadata block "URL")
//
// Half-step ratings are validated; violations become per-row warnings (the row
// is kept with rating = null) — never thrown. Warning messages carry NO film
// names or values (personal data) — only category + row index + reason.

import { indexHeaders, getCol } from "../fan-edits/csv";
import type { RawArchive, RawList } from "./parse";

export type Warning = { category: string; row: number; message: string };

export type FilmRef = { name: string; year: number | null };

export type RatingRecord = FilmRef & {
  rating: number | null;
  ratedOn: string | null;
  externalUri: string | null;
};

export type DiaryRecord = FilmRef & {
  rating: number | null;
  rewatch: boolean;
  watchedDate: string | null;
  reviewText: string | null;
  externalUri: string | null;
};

export type WatchlistRecord = FilmRef & {
  externalUri: string | null;
  addedOn: string | null;
};

// 2E.1 — a "watched" flag (watched.csv): the film page URI is the dedupe key;
// markedOn is the CSV "Date" (a marked-on date, not a watch date).
export type WatchedRecord = FilmRef & {
  externalUri: string | null;
  markedOn: string | null;
};

export type ListItemRecord = FilmRef & {
  externalUri: string | null;
  position: number | null;
};

export type ListRecord = {
  name: string | null;
  externalUri: string | null;
  description: string | null;
  items: ListItemRecord[];
};

export type NormalizedImport = {
  ratings: RatingRecord[];
  diary: DiaryRecord[];
  reviews: DiaryRecord[];
  watchlist: WatchlistRecord[];
  watched: WatchedRecord[];
  lists: ListRecord[];
  // 2E.1: watched now imports — only likes/comments/profile stay skipped.
  skipped: { likes: number; comments: number; profile: number };
  warnings: Warning[];
};

function parseYear(s: string | null): number | null {
  if (!s) return null;
  const n = parseInt(s, 10);
  return Number.isInteger(n) && n >= 1850 && n <= 2100 ? n : null;
}

function parseIntOrNull(s: string | null): number | null {
  if (!s) return null;
  const n = parseInt(s, 10);
  return Number.isInteger(n) ? n : null;
}

// Mirror the title_ratings CHECK (numeric(2,1), 0.5–5.0, half-steps).
function isHalfStep(n: number): boolean {
  return (
    Number.isFinite(n) && n >= 0.5 && n <= 5.0 && n * 2 === Math.floor(n * 2)
  );
}

function parseRating(
  s: string | null,
  category: string,
  row: number,
  warnings: Warning[],
): number | null {
  if (!s) return null;
  const n = Number(s);
  if (!isHalfStep(n)) {
    warnings.push({
      category,
      row,
      message: "rating is not a valid 0.5–5.0 half-step; dropped",
    });
    return null;
  }
  return n;
}

function dataRowCount(rows: string[][] | null): number {
  return rows && rows.length > 1 ? rows.length - 1 : 0;
}

function normRatings(rows: string[][] | null, warnings: Warning[]): RatingRecord[] {
  if (!rows || rows.length < 2) return [];
  const h = indexHeaders(rows[0]);
  const out: RatingRecord[] = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const name = getCol(row, h, "name");
    if (!name) {
      warnings.push({ category: "ratings", row: r, message: "missing film name; skipped" });
      continue;
    }
    out.push({
      name,
      year: parseYear(getCol(row, h, "year")),
      rating: parseRating(getCol(row, h, "rating"), "ratings", r, warnings),
      ratedOn: getCol(row, h, "date"),
      externalUri: getCol(row, h, "letterboxd uri"),
    });
  }
  return out;
}

function normDiaryLike(
  rows: string[][] | null,
  category: "diary" | "reviews",
  warnings: Warning[],
): DiaryRecord[] {
  if (!rows || rows.length < 2) return [];
  const h = indexHeaders(rows[0]);
  const withReview = category === "reviews";
  const out: DiaryRecord[] = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const name = getCol(row, h, "name");
    if (!name) {
      warnings.push({ category, row: r, message: "missing film name; skipped" });
      continue;
    }
    const rewatchRaw = (getCol(row, h, "rewatch") ?? "").toLowerCase();
    out.push({
      name,
      year: parseYear(getCol(row, h, "year")),
      rating: parseRating(getCol(row, h, "rating"), category, r, warnings),
      rewatch: rewatchRaw === "yes",
      watchedDate: getCol(row, h, "watched date"),
      reviewText: withReview ? getCol(row, h, "review") : null,
      // per-entry permalink (rewatch-safe) — the "Letterboxd URI" column here is
      // the diary/review entry URL, not the film page.
      externalUri: getCol(row, h, "letterboxd uri"),
    });
  }
  return out;
}

function normWatchlist(rows: string[][] | null, warnings: Warning[]): WatchlistRecord[] {
  if (!rows || rows.length < 2) return [];
  const h = indexHeaders(rows[0]);
  const out: WatchlistRecord[] = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const name = getCol(row, h, "name");
    if (!name) {
      warnings.push({ category: "watchlist", row: r, message: "missing film name; skipped" });
      continue;
    }
    out.push({
      name,
      year: parseYear(getCol(row, h, "year")),
      externalUri: getCol(row, h, "letterboxd uri"),
      addedOn: getCol(row, h, "date"),
    });
  }
  return out;
}

// watched.csv: Date, Name, Year, Letterboxd URI (the FILM page — the dedupe
// key, mirroring ratings/watchlist). No rating / rewatch / review here.
function normWatched(rows: string[][] | null, warnings: Warning[]): WatchedRecord[] {
  if (!rows || rows.length < 2) return [];
  const h = indexHeaders(rows[0]);
  const out: WatchedRecord[] = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const name = getCol(row, h, "name");
    if (!name) {
      warnings.push({ category: "watched", row: r, message: "missing film name; skipped" });
      continue;
    }
    out.push({
      name,
      year: parseYear(getCol(row, h, "year")),
      externalUri: getCol(row, h, "letterboxd uri"),
      markedOn: getCol(row, h, "date"),
    });
  }
  return out;
}

function normList(rl: RawList, warnings: Warning[]): ListRecord {
  let name: string | null = null;
  let externalUri: string | null = null;
  let description: string | null = null;
  if (rl.metaHeader && rl.metaRow) {
    const mh = indexHeaders(rl.metaHeader);
    name = getCol(rl.metaRow, mh, "name");
    externalUri = getCol(rl.metaRow, mh, "url"); // the list's own URL
    description = getCol(rl.metaRow, mh, "description");
  }
  const items: ListItemRecord[] = [];
  if (rl.dataHeader) {
    const dh = indexHeaders(rl.dataHeader);
    for (let r = 0; r < rl.dataRows.length; r++) {
      const row = rl.dataRows[r];
      const itemName = getCol(row, dh, "name");
      if (!itemName) {
        warnings.push({
          // 1-based to match the other normalizers' row numbering; the slug
          // disambiguates which list emitted it (the user's own list slug).
          category: `list:${rl.fileSlug}`,
          row: r + 1,
          message: "missing film name; skipped",
        });
        continue;
      }
      items.push({
        name: itemName,
        year: parseYear(getCol(row, dh, "year")),
        externalUri: getCol(row, dh, "url"), // the film URL
        position: parseIntOrNull(getCol(row, dh, "position")),
      });
    }
  }
  return { name, externalUri, description, items };
}

export function normalizeArchive(archive: RawArchive): NormalizedImport {
  const warnings: Warning[] = [];
  return {
    ratings: normRatings(archive.ratings, warnings),
    diary: normDiaryLike(archive.diary, "diary", warnings),
    reviews: normDiaryLike(archive.reviews, "reviews", warnings),
    watchlist: normWatchlist(archive.watchlist, warnings),
    watched: normWatched(archive.watched, warnings),
    lists: archive.lists.map((rl) => normList(rl, warnings)),
    skipped: {
      likes: dataRowCount(archive.likesFilms),
      comments: dataRowCount(archive.comments),
      profile: dataRowCount(archive.profile),
    },
    warnings,
  };
}

// Collect the unique film references (name + year) across every matchable
// category, in a stable order, with a dedupe key. The import route feeds these
// to match_letterboxd_films and maps results back by key.
export function collectFilmRefs(n: NormalizedImport): {
  refs: FilmRef[];
  keyOf: (ref: FilmRef) => string;
} {
  const keyOf = (ref: FilmRef) =>
    `${ref.name.trim().toLowerCase()}|${ref.year ?? ""}`;
  const seen = new Set<string>();
  const refs: FilmRef[] = [];
  const add = (ref: FilmRef) => {
    const k = keyOf(ref);
    if (seen.has(k)) return;
    seen.add(k);
    refs.push({ name: ref.name, year: ref.year });
  };
  n.ratings.forEach(add);
  n.diary.forEach(add);
  n.reviews.forEach(add);
  n.watchlist.forEach(add);
  n.watched.forEach(add);
  n.lists.forEach((l) => l.items.forEach(add));
  return { refs, keyOf };
}
