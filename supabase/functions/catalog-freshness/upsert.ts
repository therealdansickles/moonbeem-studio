// Upsert logic for the catalog-freshness Edge Function.
//
// Two-step (not single upsert) because the column allowlist for
// UPDATE differs from INSERT:
//   UPDATE: never touches is_active, is_featured, slug, distributor,
//           created_at, media_type, tmdb_id (preservation contract
//           per RUNBOOK_BLOCK_D_CATALOG_FRESHNESS.md).
//   INSERT: provides slug (stub form: tmdb-{m|t}-{id}), media_type,
//           tmdb_id, plus the full TMDb-derived field set.
//           is_active=false default, is_featured=false default.
//           Stubs are intentional — /changes returns ids whose
//           proper slug we'd have to mint from title+year, which
//           risks collisions against the existing 1.4M rows. Stub
//           slugs are guaranteed unique and a separate cleanup pass
//           can promote them later if needed.
//
// Tripwires enforced here:
//   - is_active=true row -> log SKIPPED_ACTIVE and return
//     {action:'skipped_active'}. Never modified.
//   - unknown mediaType -> throw. index.ts hardcodes FEEDS=
//     ['movie','tv']; this guard catches a future expansion that
//     forgot to add a code branch.
//
// Adult-content filter:
//   The existing 1.4M-row corpus was built by a discovery pipeline
//   that filtered adult titles BEFORE enrichment (see
//   scripts/scraper/discover_full_catalog.py:176 and
//   scripts/scraper/tmdb_discover.py:89 with include_adult=False).
//   /movie/changes and /tv/changes have no adult filter, so we
//   reproduce the discovery-time behavior here: if details.adult ===
//   true, log SKIPPED_ADULT and return {action:'skipped_adult'}
//   without touching the DB. Keeps the corpus consistent with its
//   prior shape.
//
// Returns:
//   {action: 'inserted'}        — new row written
//   {action: 'updated'}         — existing row touched (allowlist)
//   {action: 'skipped_active'}  — existing row had is_active=true
//   {action: 'skipped_adult'}   — TMDb flagged title as adult
//
// Throws on hard errors (DB error, unknown media_type, etc.) — caller
// (index.ts) catches and logs.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const TMDB_IMG_W500 = "https://image.tmdb.org/t/p/w500";
const TMDB_IMG_ORIGINAL = "https://image.tmdb.org/t/p/original";

export type UpsertResult =
  | { action: "inserted" }
  | { action: "updated" }
  | { action: "skipped_active" }
  | { action: "skipped_adult" };

type MediaType = "movie" | "tv";

type CrewMember = {
  name: string | null;
  job: string | null;
  department: string | null;
  profile_path: string | null;
};

type CastMember = {
  name: string | null;
  character: string | null;
  order: number | null;
  profile_path: string | null;
};

type CompanyOrNetwork = {
  id: number | null;
  name: string | null;
  logo_path: string | null;
  origin_country: string | null;
};

// ---------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------

export async function upsertTitle(
  supabase: SupabaseClient,
  mediaType: string,
  details: Record<string, unknown>,
): Promise<UpsertResult> {
  if (mediaType !== "movie" && mediaType !== "tv") {
    throw new Error(
      `[catalog-freshness] TRIPWIRE: unknown media_type=${mediaType}. ` +
        `Stopping — index.ts FEEDS expanded without a code branch?`,
    );
  }
  const tmdbId = Number(details.id);
  if (!Number.isFinite(tmdbId) || tmdbId <= 0) {
    throw new Error(
      `[catalog-freshness] details missing or invalid id: ${details.id}`,
    );
  }

  // Adult-content filter — match the discovery-pipeline behavior that
  // built the existing 1.4M corpus. /changes returns adult titles
  // unfiltered; we drop them before any DB read or write.
  if (details.adult === true) {
    console.log(
      `[catalog-freshness] SKIPPED_ADULT tmdb_id=${tmdbId} media_type=${mediaType} reason=adult_content_filter`,
    );
    return { action: "skipped_adult" };
  }

  const existing = await supabase
    .from("titles")
    .select("id, is_active")
    .eq("tmdb_id", tmdbId)
    .eq("media_type", mediaType)
    .maybeSingle();

  if (existing.error) {
    throw new Error(
      `[catalog-freshness] lookup failed for tmdb_id=${tmdbId} ` +
        `media_type=${mediaType}: ${existing.error.message}`,
    );
  }

  if (existing.data) {
    if (existing.data.is_active === true) {
      console.log(
        `[catalog-freshness] SKIPPED_ACTIVE tmdb_id=${tmdbId} media_type=${mediaType} reason=is_active_protection`,
      );
      return { action: "skipped_active" };
    }
    const updateRecord = mediaType === "movie"
      ? buildMovieUpdate(details)
      : buildTvUpdate(details);
    const { error } = await supabase
      .from("titles")
      .update(updateRecord)
      .eq("id", existing.data.id);
    if (error) {
      throw new Error(
        `[catalog-freshness] update failed for tmdb_id=${tmdbId} ` +
          `media_type=${mediaType}: ${error.message}`,
      );
    }
    return { action: "updated" };
  }

  const insertRecord = mediaType === "movie"
    ? buildMovieInsert(details, tmdbId)
    : buildTvInsert(details, tmdbId);
  const { error } = await supabase.from("titles").insert(insertRecord);
  if (error) {
    throw new Error(
      `[catalog-freshness] insert failed for tmdb_id=${tmdbId} ` +
        `media_type=${mediaType}: ${error.message}`,
    );
  }
  return { action: "inserted" };
}

// ---------------------------------------------------------------------
// Field shaping (parallels scripts/scraper/enrich_full_catalog.py)
// ---------------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString();
}

function stubSlug(mediaType: MediaType, tmdbId: number): string {
  return `tmdb-${mediaType === "movie" ? "m" : "t"}-${tmdbId}`;
}

function parseYear(dateStr: string | null | undefined): number | null {
  if (!dateStr) return null;
  const y = parseInt(String(dateStr).slice(0, 4), 10);
  return Number.isFinite(y) ? y : null;
}

function asString(v: unknown): string | null {
  if (typeof v === "string") return v;
  return null;
}

function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return null;
}

function imageUrl(path: unknown, base: string): string | null {
  const p = asString(path);
  return p ? `${base}${p}` : null;
}

function slimCast(raw: unknown): CastMember[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((c) => {
    const o = c as Record<string, unknown>;
    return {
      name: asString(o.name),
      character: asString(o.character),
      order: asNumber(o.order),
      profile_path: asString(o.profile_path),
    };
  });
}

function slimCrew(raw: unknown): CrewMember[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((c) => {
    const o = c as Record<string, unknown>;
    return {
      name: asString(o.name),
      job: asString(o.job),
      department: asString(o.department),
      profile_path: asString(o.profile_path),
    };
  });
}

function slimCompanies(raw: unknown): CompanyOrNetwork[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((c) => {
    const o = c as Record<string, unknown>;
    return {
      id: asNumber(o.id),
      name: asString(o.name),
      logo_path: asString(o.logo_path),
      origin_country: asString(o.origin_country),
    };
  });
}

function genreNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((g) => asString((g as Record<string, unknown>).name))
    .filter((n): n is string => typeof n === "string");
}

function countryCodes(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((c) => asString((c as Record<string, unknown>).iso_3166_1))
    .filter((n): n is string => typeof n === "string");
}

function keywordNames(details: Record<string, unknown>): string[] {
  // /movie/{id}?append_to_response=keywords -> details.keywords.keywords[]
  // /tv/{id}?append_to_response=keywords    -> details.keywords.results[]
  const kw = details.keywords as Record<string, unknown> | undefined;
  if (!kw) return [];
  const arr = (kw.keywords ?? kw.results) as unknown;
  if (!Array.isArray(arr)) return [];
  return arr
    .map((k) => asString((k as Record<string, unknown>).name))
    .filter((n): n is string => typeof n === "string");
}

function imdbId(details: Record<string, unknown>): string | null {
  const ext = details.external_ids as Record<string, unknown> | undefined;
  return asString(ext?.imdb_id);
}

function trailers(details: Record<string, unknown>): unknown[] {
  // videos.results[] — caller can filter further; keep raw shape so
  // upsert.ts isn't opinionated about which trailer to surface.
  const v = details.videos as Record<string, unknown> | undefined;
  const r = v?.results;
  return Array.isArray(r) ? r : [];
}

function imagesPayload(details: Record<string, unknown>): unknown {
  // Pass through raw images object; downstream consumers can pick.
  return details.images ?? null;
}

function truncTitle(s: string | null | undefined): string {
  return (s ?? "").slice(0, 300);
}

// Allowlist columns built for UPDATE path. Notably ABSENT:
//   is_active, is_featured, slug, distributor, created_at,
//   media_type, tmdb_id, id.
function buildMovieUpdate(details: Record<string, unknown>): Record<string, unknown> {
  const releaseDate = asString(details.release_date);
  const runtime = asNumber(details.runtime);
  const overview = asString(details.overview);
  const credits = details.credits as Record<string, unknown> | undefined;
  return {
    title: truncTitle(
      asString(details.title) ?? asString(details.original_title),
    ),
    original_title: asString(details.original_title),
    tagline: asString(details.tagline),
    overview,
    synopsis: overview,
    poster_url: imageUrl(details.poster_path, TMDB_IMG_W500),
    poster_url_hd: imageUrl(details.poster_path, TMDB_IMG_ORIGINAL),
    backdrop_url: imageUrl(details.backdrop_path, TMDB_IMG_W500),
    backdrop_url_hd: imageUrl(details.backdrop_path, TMDB_IMG_ORIGINAL),
    popularity: asNumber(details.popularity),
    vote_average: asNumber(details.vote_average),
    runtime_min: runtime,
    runtime_mins: runtime,
    genres: genreNames(details.genres),
    countries: countryCodes(details.production_countries),
    keywords: keywordNames(details),
    production_companies: slimCompanies(details.production_companies),
    cast_members: slimCast(credits?.cast),
    crew: slimCrew(credits?.crew),
    release_date: releaseDate || null,
    year: parseYear(releaseDate),
    imdb_id: imdbId(details),
    images: imagesPayload(details),
    trailers: trailers(details),
    tmdb_matched: true,
    enriched_at: nowIso(),
    scraped_at: nowIso(),
  };
}

function buildTvUpdate(details: Record<string, unknown>): Record<string, unknown> {
  const firstAir = asString(details.first_air_date);
  const lastAir = asString(details.last_air_date);
  const runtimeArr = details.episode_run_time as unknown;
  const runtime = Array.isArray(runtimeArr) && runtimeArr.length > 0
    ? asNumber(runtimeArr[0])
    : null;
  const overview = asString(details.overview);
  const credits = details.credits as Record<string, unknown> | undefined;
  return {
    title: truncTitle(
      asString(details.name) ?? asString(details.original_name),
    ),
    original_title: asString(details.original_name),
    tagline: asString(details.tagline),
    overview,
    synopsis: overview,
    poster_url: imageUrl(details.poster_path, TMDB_IMG_W500),
    poster_url_hd: imageUrl(details.poster_path, TMDB_IMG_ORIGINAL),
    backdrop_url: imageUrl(details.backdrop_path, TMDB_IMG_W500),
    backdrop_url_hd: imageUrl(details.backdrop_path, TMDB_IMG_ORIGINAL),
    popularity: asNumber(details.popularity),
    vote_average: asNumber(details.vote_average),
    runtime_min: runtime,
    runtime_mins: runtime,
    genres: genreNames(details.genres),
    countries: countryCodes(details.origin_country)
      // TMDb TV uses origin_country: ['US'] (top-level array of codes)
      // rather than production_countries shape. Fall back if missing.
      .concat(countryCodes(details.production_countries))
      .filter((v, i, a) => a.indexOf(v) === i),
    keywords: keywordNames(details),
    networks: slimCompanies(details.networks),
    production_companies: slimCompanies(details.production_companies),
    cast_members: slimCast(credits?.cast),
    crew: slimCrew(credits?.crew),
    first_air_date: firstAir || null,
    last_air_date: lastAir || null,
    year: parseYear(firstAir),
    number_of_seasons: asNumber(details.number_of_seasons),
    number_of_episodes: asNumber(details.number_of_episodes),
    imdb_id: imdbId(details),
    images: imagesPayload(details),
    trailers: trailers(details),
    tmdb_matched: true,
    enriched_at: nowIso(),
    scraped_at: nowIso(),
  };
}

function buildMovieInsert(
  details: Record<string, unknown>,
  tmdbId: number,
): Record<string, unknown> {
  const update = buildMovieUpdate(details);
  return {
    ...update,
    slug: stubSlug("movie", tmdbId),
    tmdb_id: tmdbId,
    media_type: "movie",
    is_active: false,
    is_featured: false,
  };
}

function buildTvInsert(
  details: Record<string, unknown>,
  tmdbId: number,
): Record<string, unknown> {
  const update = buildTvUpdate(details);
  return {
    ...update,
    slug: stubSlug("tv", tmdbId),
    tmdb_id: tmdbId,
    media_type: "tv",
    is_active: false,
    is_featured: false,
  };
}
