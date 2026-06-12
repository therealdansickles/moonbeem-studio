// Phase 2B — Letterboxd import job: POST creates the job + kicks the async
// preview worker; GET returns the caller's job (owner-scoped). NO writes to the
// four content tables — this stage produces a PREVIEW only. The apply step
// (preview_ready -> applying -> completed) is Phase 2C; the UI's Apply button
// renders disabled here.

import { NextResponse, after, type NextRequest } from "next/server";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getCurrentProfile } from "@/lib/dal";
import { enforce } from "@/lib/ratelimit";
import { getR2Client, getR2Bucket } from "@/lib/r2/client";
import { createServiceRoleClient } from "@/lib/supabase/service";
import {
  requireCreatorForImport,
  matchFilms,
  type FilmMatch,
} from "@/lib/letterboxd/server";
import { parseLetterboxdArchive } from "@/lib/letterboxd/parse";
import { normalizeArchive, collectFilmRefs } from "@/lib/letterboxd/normalize";
import type { FilmRef } from "@/lib/letterboxd/normalize";
import {
  buildPreview,
  buildApplyPayload,
  type ExistingUris,
  type ResolvedMatch,
} from "@/lib/letterboxd/preview";
import type { SupabaseClient } from "@supabase/supabase-js";

const MAX_BYTES = 25 * 1024 * 1024;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The preview worker runs in after() INSIDE this invocation, so it must finish
// within the function's maxDuration. Budget: in-memory unzip (fflate, sync; 25 MB
// hard cap, real exports << 1 MB) + ceil(N/100) sequential match RPCs (recon: 836
// refs -> 9 chunks, each index-served and well under service_role's 8s
// statement_timeout) + O(rows) preview assembly + a few small existing-uri SELECTs
// — a few seconds in practice. 60s is the ceiling on Vercel Hobby and far under
// Pro's 300s, so it is valid on any plan (the project's exact plan could not be
// confirmed via the CLI in this environment). 60 gives wide headroom.
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  const gate = await requireCreatorForImport("me/letterboxd/import");
  if ("error" in gate) return gate.error;
  const { userId, creatorId } = gate;

  let body: { r2_key?: string };
  try {
    body = (await request.json()) as { r2_key?: string };
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const r2Key = (body.r2_key ?? "").trim();
  // The key MUST be in the caller's own upload namespace (an attacker must not
  // be able to point a job at someone else's object or traverse the bucket).
  const prefix = `letterboxd-imports/${userId}/`;
  if (
    !r2Key.startsWith(prefix) ||
    !r2Key.endsWith(".zip") ||
    r2Key.includes("..") ||
    r2Key.length > 256
  ) {
    return NextResponse.json({ error: "invalid r2_key" }, { status: 400 });
  }

  const sb = createServiceRoleClient();
  const { data: job, error: jobErr } = await sb
    .from("letterboxd_import_jobs")
    .insert({
      user_id: userId,
      creator_id: creatorId,
      r2_path: r2Key,
      status: "pending",
    })
    .select("id")
    .maybeSingle();
  if (jobErr || !job) {
    return NextResponse.json(
      { error: `job create failed: ${jobErr?.message ?? "no row"}` },
      { status: 500 },
    );
  }
  const jobId = job.id as string;

  // Fire-and-forget worker. Mirrors admin/fan-edits/bulk/commit's after()
  // idiom: it runs after the response but INSIDE the same function invocation,
  // so it must finish within the function timeout. Size math: the 25 MB cap is
  // the hard ceiling; realistic exports are well under 1 MB (this fixture is
  // 33 KB). Work is in-memory unzip (fflate, sync), ONE set-based match RPC over
  // a few hundred-to-low-thousand unique films (seconds), plus O(rows) preview
  // assembly — comfortably within budget. No per-row external calls.
  after(async () => {
    await processImportJob(jobId, userId, creatorId, r2Key);
  });

  return NextResponse.json({ ok: true, job_id: jobId });
}

export async function GET(request: NextRequest) {
  const profile = await getCurrentProfile();
  const userId = profile?.userId ?? null;
  if (!userId) {
    return NextResponse.json({ error: "auth_required" }, { status: 401 });
  }
  // Rate-limit the poll GET like the fan-edits bulk jobs GET (the client polls
  // every 2s; this caps abusive hammering).
  const rl = await enforce("userWrites", userId, "me/letterboxd/poll");
  if (!rl.ok) return rl.response;
  const jobId = (request.nextUrl.searchParams.get("job_id") ?? "").trim();
  if (!UUID_RE.test(jobId)) {
    return NextResponse.json({ error: "invalid job_id" }, { status: 400 });
  }
  const sb = createServiceRoleClient();
  const { data: job } = await sb
    .from("letterboxd_import_jobs")
    .select("id, user_id, status, counts, preview, error, created_at")
    .eq("id", jobId)
    .maybeSingle();
  // Owner-scoped: a job that isn't the caller's reads as 404, not 403, so job
  // ids aren't an existence oracle.
  if (!job || (job.user_id as string) !== userId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return NextResponse.json({
    status: job.status,
    counts: job.counts ?? null,
    preview: job.preview ?? null,
    error: job.error ?? null,
    created_at: job.created_at,
  });
}

// ---- async worker -------------------------------------------------------

async function processImportJob(
  jobId: string,
  _userId: string,
  creatorId: string,
  r2Key: string,
): Promise<void> {
  const sb = createServiceRoleClient();
  try {
    await sb
      .from("letterboxd_import_jobs")
      .update({ status: "parsing" })
      .eq("id", jobId);

    // Fetch the ZIP from R2 with a server-side size guard (the presign couldn't
    // bind a content-length-range).
    const res = await getR2Client().send(
      new GetObjectCommand({ Bucket: getR2Bucket(), Key: r2Key }),
    );
    // Fail CLOSED: a missing ContentLength is treated as a rejection, not 0.
    if (res.ContentLength == null || res.ContentLength > MAX_BYTES) {
      throw new Error(
        `zip too large or unsized: ${res.ContentLength ?? "unknown"} bytes (max ${MAX_BYTES})`,
      );
    }
    const body = res.Body as
      | { transformToByteArray: () => Promise<Uint8Array> }
      | undefined;
    if (!body) throw new Error("empty R2 object");
    const bytes = await body.transformToByteArray();
    if (bytes.byteLength > MAX_BYTES) {
      throw new Error(`zip too large: ${bytes.byteLength} bytes (max ${MAX_BYTES})`);
    }

    const archive = parseLetterboxdArchive(bytes);
    const normalized = normalizeArchive(archive);
    const { refs, keyOf } = collectFilmRefs(normalized);

    // One set-based match over the unique film refs.
    const matches = await matchFilms(sb, refs);
    const matchByIdx = new Map<number, FilmMatch>(
      matches.map((m) => [m.idx, m]),
    );

    // Enrich the fuzzy-review table with each matched title's NAME + YEAR. Only
    // FUZZY matches need this: the verification surface is "input name (year) ->
    // matched name (year)", where the year is what exposes an off-by-one in the
    // ±1 window. Exact matches are counted, not name-displayed, so we skip them.
    //
    // We look up ONLY the unique fuzzy title_ids. The prior code did .in() over
    // ALL matched ids (~hundreds for a full library), which encodes into the
    // PostgREST GET URL and overruns its length limit — the request errored, the
    // error was unchecked, `data` came back null, and EVERY fuzzy row lost its
    // name (the live row fell back to its slug, catalog rows showed a dash). The
    // fuzzy set is small (one row per fuzzy match), so its .in() URL is safe.
    // slug + is_public come straight from the RPC. service-role bypasses RLS, so
    // catalog-only (is_public=false) titles resolve here too.
    const fuzzyIds = [
      ...new Set(
        matches
          .filter((m) => m.matched_via === "fuzzy" && m.title_id)
          .map((m) => m.title_id as string),
      ),
    ];
    const fuzzyInfoById = new Map<string, { title: string; year: number | null }>();
    if (fuzzyIds.length) {
      const { data: titles, error: titleErr } = await sb
        .from("titles")
        .select("id, title, year")
        .in("id", fuzzyIds);
      if (titleErr) {
        throw new Error(`fuzzy title enrich failed: ${titleErr.message}`);
      }
      for (const t of titles ?? []) {
        fuzzyInfoById.set(t.id as string, {
          title: t.title as string,
          year: (t.year as number | null) ?? null,
        });
      }
    }

    const none: ResolvedMatch = {
      via: "none",
      titleId: null,
      slug: null,
      titleName: null,
      matchedYear: null,
      isPublic: null,
    };
    const keyToIdx = new Map<string, number>();
    refs.forEach((ref, i) => keyToIdx.set(keyOf(ref), i));
    const resolve = (ref: FilmRef): ResolvedMatch => {
      const idx = keyToIdx.get(keyOf(ref));
      const m = idx === undefined ? undefined : matchByIdx.get(idx);
      if (!m || m.matched_via === "none" || !m.title_id) return none;
      const info = fuzzyInfoById.get(m.title_id);
      return {
        via: m.matched_via,
        titleId: m.title_id,
        slug: m.slug ?? null,
        titleName: info?.title ?? null,
        matchedYear: info?.year ?? null,
        isPublic: m.is_public ?? null,
      };
    };

    const existing = await loadExistingUris(sb, creatorId);
    const preview = buildPreview(normalized, resolve, existing);
    // 2C: pin the exact rows the apply RPC will replay, written alongside the
    // display preview. NEVER shipped to the client (the GET route doesn't
    // select `payload`); apply re-reads it server-side and never re-parses.
    const payload = buildApplyPayload(normalized, resolve);

    const counts = {
      ratings: preview.categories.ratings,
      diary: preview.categories.diary,
      reviews: preview.categories.reviews,
      watchlist: preview.categories.watchlist,
      lists: preview.categories.lists,
      list_count: normalized.lists.length,
      skipped: preview.skipped,
      warnings: preview.warnings.length,
    };

    await sb
      .from("letterboxd_import_jobs")
      .update({ status: "preview_ready", preview, counts, payload })
      .eq("id", jobId);
  } catch (e) {
    await sb
      .from("letterboxd_import_jobs")
      .update({
        status: "failed",
        error: e instanceof Error ? e.message : String(e),
      })
      .eq("id", jobId);
  }
}

// The creator's already-present external_uris per surface, for the
// already_imported preview dimension. All tiny pre-import (0 rows today).
async function loadExistingUris(
  sb: SupabaseClient,
  creatorId: string,
): Promise<ExistingUris> {
  const pull = async (table: string): Promise<Set<string>> => {
    const { data } = await sb
      .from(table)
      .select("external_uri")
      .eq("creator_id", creatorId)
      .not("external_uri", "is", null);
    return new Set(
      (data ?? [])
        .map((r) => r.external_uri as string | null)
        .filter((x): x is string => Boolean(x)),
    );
  };

  const [ratings, diary, watched, listItems, lists] = await Promise.all([
    pull("title_ratings"),
    pull("diary_entries"),
    pull("watched_titles"),
    pull("user_list_items"),
    pull("user_lists"),
  ]);

  // Watchlist already-imported check spans BOTH the import container
  // (kind='list', external_uri='lb://watchlist') that the apply writes pre-
  // publish AND the native kind='watchlist' list that the publish RPC merges it
  // into. Union both lists' item URIs so a re-upload dedupes correctly in either
  // state (pre- or post-publish).
  let watchlist = new Set<string>();
  const { data: wlLists } = await sb
    .from("user_lists")
    .select("id")
    .eq("creator_id", creatorId)
    .or('kind.eq.watchlist,external_uri.eq."lb://watchlist"');
  const wlListIds = (wlLists ?? []).map((r) => r.id as string);
  if (wlListIds.length) {
    const { data: wlItems } = await sb
      .from("user_list_items")
      .select("external_uri")
      .in("list_id", wlListIds)
      .not("external_uri", "is", null);
    watchlist = new Set(
      (wlItems ?? [])
        .map((r) => r.external_uri as string | null)
        .filter((x): x is string => Boolean(x)),
    );
  }

  return { ratings, diary, watchlist, watched, listItems, lists };
}
