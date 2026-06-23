// Territory (geo) gate for Mux playback — SEAM ONLY; currently a no-op.
//
// isTerritoryAllowed(country, title) answers: may a viewer in `country` play
// this `title`? TODAY it returns true unconditionally — no per-title territory
// data exists yet.
//
// LOAD-BEARING SEAM: the upload-flow unit will later (a) populate per-title
// territory data and (b) implement the real check INSIDE THIS FUNCTION BODY.
// It must NOT need to touch the playback-token route — that route already calls
// this helper and maps a `false` result to HTTP 451. Keep this contract stable
// (country in, boolean out); only the body changes.
//
// `country` is the ISO-3166-1 alpha-2 code from the Vercel edge header
// (x-vercel-ip-country), or null when unavailable (local / non-Vercel). Treat
// null as "unknown" — allowed for now.

// Widen this when per-title territory data lands (e.g. allowed/blocked country
// lists keyed by title id). The id is enough to look that up later.
export type TerritoryTitle = { id: string };

export function isTerritoryAllowed(
  _country: string | null,
  _title: TerritoryTitle,
): boolean {
  // SEAM: no title territory data yet -> allow all. Do NOT enforce here until
  // the upload-flow unit populates territory data; implement the check in THIS
  // body only, never in the playback-token route.
  return true;
}
