// Phase 2B — build the import preview from the normalized records + the matcher
// results + the creator's already-present external_uris. Pure function: the
// route does the DB reads (match RPC + existing-uri SELECTs) and passes them in.
//
// Two orthogonal dimensions per category:
//   - MATCH: matched_exact + matched_fuzzy + unmatched = total (title resolution)
//   - DEDUPE: already_imported = how many rows' external_uri already exist for
//     this creator (would be a no-op re-import). These can overlap a match.

import type { NormalizedImport, FilmRef, Warning } from "./normalize";

export type MatchVia = "exact" | "fuzzy" | "none";

export type ResolvedMatch = {
  via: MatchVia;
  titleId: string | null;
  slug: string | null;
  titleName: string | null;
  matchedYear: number | null;
  isPublic: boolean | null;
};

export type CategoryStats = {
  total: number;
  matched_exact: number;
  matched_fuzzy: number;
  // 2B.1: of the matched (exact + fuzzy), how many resolved to a LIVE title
  // (is_public) vs a catalog-only one (a staged title not yet published).
  // matched_live + matched_catalog === matched_exact + matched_fuzzy.
  matched_live: number;
  matched_catalog: number;
  unmatched: number;
  already_imported: number;
};

export type FuzzyPair = {
  category: string;
  input_name: string;
  input_year: number | null;
  matched_name: string | null;
  // 2B.2: matched title's year — the verification surface for a ±1-year fuzzy
  // match is "input (year) -> matched (year)"; the year makes the off-by-one visible.
  matched_year: number | null;
  matched_slug: string | null;
  // 2B.1: the UI links /t/{slug} only when the matched title is live.
  matched_is_public: boolean;
};

export type UnmatchedRef = { category: string; name: string; year: number | null };

export type ListPreview = {
  name: string | null;
  item_total: number;
  matched_exact: number;
  matched_fuzzy: number;
  unmatched: number;
  already_imported: number;
  already_imported_list: boolean; // the list CONTAINER (its own URL) already imported
};

export type ImportPreview = {
  categories: {
    ratings: CategoryStats;
    diary: CategoryStats;
    reviews: CategoryStats;
    watchlist: CategoryStats;
    lists: CategoryStats;
  };
  lists: ListPreview[];
  fuzzy_pairs: FuzzyPair[];
  unmatched: UnmatchedRef[];
  fuzzy_truncated: number; // fuzzy pairs beyond the cap, not materialized
  unmatched_truncated: number;
  skipped: { watched: number; likes: number; comments: number; profile: number };
  warnings: Warning[];
};

export type ExistingUris = {
  ratings: Set<string>;
  diary: Set<string>; // covers diary + reviews (both are diary_entries)
  watchlist: Set<string>;
  listItems: Set<string>;
  lists: Set<string>;
};

// Cap the materialized name-bearing arrays so the preview jsonb stays bounded
// even for very large libraries; the per-category COUNTS are always exact.
const LIST_CAP = 1000;

type WithUri = FilmRef & { externalUri: string | null };

function accumulate(
  records: WithUri[],
  category: string,
  existing: Set<string>,
  resolve: (ref: FilmRef) => ResolvedMatch,
  sink: { fuzzy: FuzzyPair[]; unmatched: UnmatchedRef[]; truncFuzzy: () => void; truncUnmatched: () => void },
): CategoryStats {
  let matched_exact = 0;
  let matched_fuzzy = 0;
  let matched_live = 0;
  let matched_catalog = 0;
  let unmatched = 0;
  let already_imported = 0;
  for (const rec of records) {
    const m = resolve(rec);
    if (m.via === "exact" || m.via === "fuzzy") {
      if (m.via === "exact") matched_exact++;
      else matched_fuzzy++;
      if (m.isPublic) matched_live++;
      else matched_catalog++;
    }
    if (m.via === "fuzzy") {
      if (sink.fuzzy.length < LIST_CAP) {
        sink.fuzzy.push({
          category,
          input_name: rec.name,
          input_year: rec.year,
          matched_name: m.titleName,
          matched_year: m.matchedYear,
          matched_slug: m.slug,
          matched_is_public: Boolean(m.isPublic),
        });
      } else {
        sink.truncFuzzy();
      }
    } else if (m.via === "none") {
      unmatched++;
      if (sink.unmatched.length < LIST_CAP) {
        sink.unmatched.push({ category, name: rec.name, year: rec.year });
      } else {
        sink.truncUnmatched();
      }
    }
    if (rec.externalUri && existing.has(rec.externalUri)) already_imported++;
  }
  return {
    total: records.length,
    matched_exact,
    matched_fuzzy,
    matched_live,
    matched_catalog,
    unmatched,
    already_imported,
  };
}

export function buildPreview(
  n: NormalizedImport,
  resolve: (ref: FilmRef) => ResolvedMatch,
  existing: ExistingUris,
): ImportPreview {
  const fuzzy: FuzzyPair[] = [];
  const unmatched: UnmatchedRef[] = [];
  let fuzzyTrunc = 0;
  let unmatchedTrunc = 0;
  const sink = {
    fuzzy,
    unmatched,
    truncFuzzy: () => {
      fuzzyTrunc++;
    },
    truncUnmatched: () => {
      unmatchedTrunc++;
    },
  };

  const ratings = accumulate(n.ratings, "ratings", existing.ratings, resolve, sink);
  const diary = accumulate(n.diary, "diary", existing.diary, resolve, sink);
  const reviews = accumulate(n.reviews, "reviews", existing.diary, resolve, sink);
  const watchlist = accumulate(
    n.watchlist,
    "watchlist",
    existing.watchlist,
    resolve,
    sink,
  );

  // Lists: per-list breakdown + an aggregate "lists" category over all items.
  const listPreviews: ListPreview[] = [];
  let lAggExact = 0;
  let lAggFuzzy = 0;
  let lAggLive = 0;
  let lAggCatalog = 0;
  let lAggUnmatched = 0;
  let lAggAlready = 0;
  let lAggTotal = 0;
  for (const list of n.lists) {
    const s = accumulate(
      list.items,
      `list:${list.name ?? "untitled"}`,
      existing.listItems,
      resolve,
      sink,
    );
    listPreviews.push({
      name: list.name,
      item_total: s.total,
      matched_exact: s.matched_exact,
      matched_fuzzy: s.matched_fuzzy,
      unmatched: s.unmatched,
      already_imported: s.already_imported,
      already_imported_list: Boolean(
        list.externalUri && existing.lists.has(list.externalUri),
      ),
    });
    lAggTotal += s.total;
    lAggExact += s.matched_exact;
    lAggFuzzy += s.matched_fuzzy;
    lAggLive += s.matched_live;
    lAggCatalog += s.matched_catalog;
    lAggUnmatched += s.unmatched;
    lAggAlready += s.already_imported;
  }

  return {
    categories: {
      ratings,
      diary,
      reviews,
      watchlist,
      lists: {
        total: lAggTotal,
        matched_exact: lAggExact,
        matched_fuzzy: lAggFuzzy,
        matched_live: lAggLive,
        matched_catalog: lAggCatalog,
        unmatched: lAggUnmatched,
        already_imported: lAggAlready,
      },
    },
    lists: listPreviews,
    fuzzy_pairs: fuzzy,
    unmatched,
    fuzzy_truncated: fuzzyTrunc,
    unmatched_truncated: unmatchedTrunc,
    skipped: n.skipped,
    warnings: n.warnings,
  };
}

// 2C apply payload — the rows the apply RPC replays, pinned at preview time and
// stored on the job (never shipped to the client). Mirrors the RPC's
// jsonb_to_recordset shapes exactly. apply-all-as-previewed: unmatched rows are
// included with title_id null (raw_title/raw_year/external_uri carry them).
export type ApplyPayload = {
  ratings: Array<{
    title_id: string | null;
    rating: number;
    rated_on: string | null;
    external_uri: string | null;
    raw_title: string;
    raw_year: number | null;
  }>;
  diary: Array<{
    title_id: string | null;
    rating: number | null;
    watched_on: string | null;
    review_text: string | null;
    contains_spoilers: boolean;
    rewatch: boolean;
    external_uri: string | null;
    raw_title: string;
    raw_year: number | null;
  }>;
  containers: Array<{
    name: string;
    external_uri: string | null;
    items: Array<{
      title_id: string | null;
      external_uri: string | null;
      raw_title: string;
      raw_year: number | null;
      position: number;
    }>;
  }>;
};

export function buildApplyPayload(
  n: NormalizedImport,
  resolve: (ref: FilmRef) => ResolvedMatch,
): ApplyPayload {
  const tid = (ref: FilmRef): string | null => resolve(ref).titleId;
  return {
    // title_ratings.rating is NOT NULL — drop rows whose rating didn't validate.
    ratings: n.ratings
      .filter((r) => r.rating != null)
      .map((r) => ({
        title_id: tid(r),
        rating: r.rating as number,
        rated_on: r.ratedOn,
        external_uri: r.externalUri,
        raw_title: r.name,
        raw_year: r.year,
      })),
    // diary + reviews both land in diary_entries (deduped on the per-entry
    // permalink). diary_entries.watched_on is NOT NULL — drop null-watched rows.
    // contains_spoilers defaults false (Letterboxd's per-review spoiler flag is
    // not parsed in v1).
    diary: [...n.diary, ...n.reviews]
      .filter((d) => Boolean(d.watchedDate))
      .map((d) => ({
        title_id: tid(d),
        rating: d.rating,
        watched_on: d.watchedDate,
        review_text: d.reviewText,
        contains_spoilers: false,
        rewatch: d.rewatch,
        external_uri: d.externalUri,
        raw_title: d.name,
        raw_year: d.year,
      })),
    // The CSV lists + the imported Watchlist (its own private list named
    // "Watchlist", external_uri 'lb://watchlist' — never the native watchlist).
    containers: [
      ...n.lists.map((l) => ({
        name: l.name ?? "Untitled list",
        external_uri: l.externalUri,
        items: l.items.map((it, idx) => ({
          title_id: tid(it),
          external_uri: it.externalUri,
          raw_title: it.name,
          raw_year: it.year,
          position: it.position ?? idx + 1,
        })),
      })),
      {
        name: "Watchlist",
        external_uri: "lb://watchlist",
        items: n.watchlist.map((w, idx) => ({
          title_id: tid(w),
          external_uri: w.externalUri,
          raw_title: w.name,
          raw_year: w.year,
          position: idx + 1,
        })),
      },
    ],
  };
}
