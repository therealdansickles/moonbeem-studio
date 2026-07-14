// Territory (geo) gate for Mux playback.
//
// isTerritoryAllowed(country, rights) answers: may a viewer in `country` play a
// title carrying these rights? Per-title rights live in two columns on titles
// (migration 20260624000001_add_title_territory_rights):
//   - territory_worldwide (boolean): licensed everywhere — skip the geo check.
//   - allowed_territories (text[]): an ISO 3166-1 alpha-2 ALLOW-list.
//
// DEFAULT-DENY: a title with NEITHER set (unset) plays NOWHERE — licensed content
// must not leak globally before the partner declares rights. The 23 pre-existing
// public titles were backfilled to worldwide so they keep playing; new titles get
// a partner-declared territory set. A NULL rights object (missing / soft-deleted
// title) is likewise denied — never allow-all on a missing rights row.
//
// PURE + SYNCHRONOUS (C1, 2026-07-13). This helper used to run its OWN
// service-role read of the titles row — a second query for a row the playback
// route had ALREADY fetched via getEpisodeForPlayback (different columns, same
// id). C1's refresh path makes this route fire more often, so the caller now
// passes the rights it already holds and this became a pure predicate: one fewer
// DB round-trip per mint, and directly unit-testable (territory.test.ts).
// The DECISION RULE below is byte-for-byte the one it replaced; only the source
// of the two columns changed.
//
// CONTRACT: the playback-token route maps a `false` -> HTTP 451. `country` is the
// ISO-3166-1 alpha-2 code from x-vercel-ip-country (or null when unavailable);
// null against a territory-restricted title is DENIED (we cannot prove the viewer
// is in-territory).

// The two rights columns, as carried on the already-loaded title. `null` = the
// title is missing or soft-deleted (fail-closed).
export type TerritoryRights = {
  allowed_territories: string[] | null;
  territory_worldwide: boolean | null;
} | null;

export function isTerritoryAllowed(
  country: string | null,
  rights: TerritoryRights,
): boolean {
  // Missing / soft-deleted title -> fail-closed.
  if (!rights) return false;

  // Licensed everywhere -> allow, no geo needed.
  if (rights.territory_worldwide === true) return true;

  const allowed = rights.allowed_territories ?? [];

  // Unset (no worldwide, no allow-list) -> default-deny: plays nowhere until the
  // partner declares territories.
  if (allowed.length === 0) return false;

  // Restricted to a list: the viewer's country must be known AND in it. An
  // unknown (null) country against a restricted title is denied.
  if (!country) return false;
  return allowed.includes(country.toUpperCase());
}
