// Territory (geo) gate for Mux playback.
//
// isTerritoryAllowed(country, title) answers: may a viewer in `country` play this
// `title`? Per-title rights live in two columns on titles (migration
// 20260624000001_add_title_territory_rights):
//   - territory_worldwide (boolean): licensed everywhere — skip the geo check.
//   - allowed_territories (text[]): an ISO 3166-1 alpha-2 ALLOW-list.
//
// DEFAULT-DENY: a title with NEITHER set (unset) plays NOWHERE — licensed content
// must not leak globally before the partner declares rights. The 23 pre-existing
// public titles were backfilled to worldwide so they keep playing; new titles get
// a partner-declared territory set (the territory selector + a publish gate land
// in the next sub-unit).
//
// CONTRACT: the playback-token route calls this and maps a `false` -> HTTP 451.
// The body is async (one service-role read, mirroring getEpisodeForPlayback); the
// route's ONLY change is the `await` at the call site — its branches/451 mapping
// are unchanged. `country` is the ISO-3166-1 alpha-2 code from x-vercel-ip-country
// (or null when unavailable); null against a territory-restricted title is DENIED
// (we cannot prove the viewer is in-territory).

import { createServiceRoleClient } from "@/lib/supabase/service";

// The id is enough — the helper looks up the title's territory rights itself.
export type TerritoryTitle = { id: string };

export async function isTerritoryAllowed(
  country: string | null,
  title: TerritoryTitle,
): Promise<boolean> {
  const supabase = createServiceRoleClient();
  const { data } = await supabase
    .from("titles")
    .select("allowed_territories, territory_worldwide")
    .eq("id", title.id)
    .is("deleted_at", null)
    .maybeSingle();

  // Missing / soft-deleted title -> fail-closed (never allow-all on a missing
  // rights row; the caller already resolved visibility separately).
  if (!data) return false;

  // Licensed everywhere -> allow, no geo needed.
  if (data.territory_worldwide === true) return true;

  const allowed = (data.allowed_territories as string[] | null) ?? [];

  // Unset (no worldwide, no allow-list) -> default-deny: plays nowhere until the
  // partner declares territories.
  if (allowed.length === 0) return false;

  // Restricted to a list: the viewer's country must be known AND in it. An
  // unknown (null) country against a restricted title is denied.
  if (!country) return false;
  return allowed.includes(country.toUpperCase());
}
