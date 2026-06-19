// POST /api/titles/[id]/episodes/thumbnails — best-effort, re-runnable cover
// enrichment. Auto-derives an Instagram cover for each title_episodes row that
// still has cover_image_url IS NULL, RE-HOSTS it to R2, and stores the durable
// R2 url. DECOUPLED from the bulk-add route (which never sets covers) — this is
// pure presentation enrichment, money-rail-free, Mux-independent.
//
// Re-runnable: each call processes only still-null episodes (up to a cap), so
// re-running picks up whatever remains (or what failed last time). A per-episode
// failure (fetch 403/timeout/non-image, R2 error) is caught + skipped → that
// episode keeps cover_image_url NULL → EpisodeList renders the numbered tile. A
// failure NEVER errors the pass or any sibling episode.
//
// NOTE: the IG media-redirect (…/media/?size=l → 302 → cdninstagram .jpg) is
// tokenless and worked from a non-Vercel probe; whether Vercel's datacenter IPs
// are blocked/rate-limited by IG is the open question this route's first run
// answers. We NEVER store the cdninstagram url (signed/expiring/hotlink-blocked
// — the temp-host fragility we already fixed); we re-host the bytes to R2.

import { NextResponse, type NextRequest } from "next/server";
import { revalidatePath } from "next/cache";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { getUser } from "@/lib/dal";
import { enforce } from "@/lib/ratelimit";
import { createServiceRoleClient } from "@/lib/supabase/service";
import type { SupabaseClient } from "@supabase/supabase-js";
import { authorizeTitleMutation } from "@/lib/auth/title-mutation";
import { buildEpisodeThumbKey, buildPublicUrl } from "@/lib/r2/upload";
import { getR2Bucket, getR2Client } from "@/lib/r2/client";

// The S3 SDK needs Node APIs (not Edge); the IG fetch + R2 uploads need headroom.
export const runtime = "nodejs";
export const maxDuration = 60;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Per-invocation cap: keep one request well within the function timeout. With
// CONCURRENCY=4 and a 5s per-fetch timeout, 12 episodes = ~3 waves ≈ 15s worst
// case — comfortable under maxDuration. Re-run to continue (remaining>0).
const PER_INVOCATION_CAP = 12;
const CONCURRENCY = 4;
const FETCH_TIMEOUT_MS = 5000;

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// Pull the IG shortcode out of the canonical embed_url
// (https://www.instagram.com/{p|reel|reels}/{shortcode}/).
function shortcodeOf(embedUrl: string): string | null {
  const m = embedUrl.match(/\/(?:p|reel|reels)\/([A-Za-z0-9_-]+)\/?$/i);
  return m ? m[1] : null;
}

async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, {
      headers: { "user-agent": BROWSER_UA, accept: "image/*,*/*" },
      redirect: "follow",
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(t);
  }
}

// Derive + re-host + persist one episode's cover. Returns "ok" | "fail".
// Throws nothing — every failure mode resolves to "fail".
async function deriveAndStore(
  supabase: SupabaseClient,
  titleSlug: string,
  ep: { id: string; embed_url: string },
): Promise<"ok" | "fail"> {
  try {
    const sc = shortcodeOf(ep.embed_url);
    if (!sc) return "fail";

    const res = await fetchWithTimeout(
      `https://www.instagram.com/p/${sc}/media/?size=l`,
      FETCH_TIMEOUT_MS,
    );
    if (!res.ok) return "fail";
    const ctype = (res.headers.get("content-type") ?? "").split(";")[0].trim();
    if (!ctype.startsWith("image/")) return "fail"; // login wall / html / etc.
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength === 0) return "fail";

    // Re-host to R2 (server-side PutObject — NOT a presigned browser PUT, and no
    // Content-Disposition so it serves inline). Stable key per shortcode.
    const key = buildEpisodeThumbKey(titleSlug, sc);
    await getR2Client().send(
      new PutObjectCommand({
        Bucket: getR2Bucket(),
        Key: key,
        Body: bytes,
        ContentType: ctype,
      }),
    );
    const url = buildPublicUrl(key);

    // Persist the R2 url (NEVER the cdninstagram url). Guard with IS NULL so a
    // concurrent run can't double-write, and CONFIRM via the returned row
    // (select-confirm, not rowsAffected).
    const { data: updated, error } = await supabase
      .from("title_episodes")
      .update({ cover_image_url: url })
      .eq("id", ep.id)
      .is("cover_image_url", null)
      .select("id, cover_image_url")
      .maybeSingle();
    if (error || !updated || updated.cover_image_url !== url) return "fail";
    return "ok";
  } catch (err) {
    console.warn(
      `[episode-thumb] ${ep.id} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return "fail";
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getUser();
  if (!user) {
    return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  }
  const rl = await enforce("partnerWrites", user.id, "titles/episode-thumbs");
  if (!rl.ok) return rl.response;

  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "title_not_found" }, { status: 404 });
  }

  // AUTHORIZE FIRST — same gate + mapping as the poster + episodes routes.
  const authz = await authorizeTitleMutation(user.id, id);
  if (!authz.ok) {
    const status =
      authz.reason === "not_authenticated"
        ? 401
        : authz.reason === "title_not_found"
          ? 404
          : 403;
    return NextResponse.json({ error: authz.reason }, { status });
  }

  const supabase = createServiceRoleClient();

  const { data: title } = await supabase
    .from("titles")
    .select("slug")
    .eq("id", id)
    .maybeSingle();
  if (!title) {
    return NextResponse.json({ error: "title_not_found" }, { status: 404 });
  }
  const titleSlug = title.slug as string;

  // Total still-null instagram covers (for the remaining count).
  const { count: totalNull } = await supabase
    .from("title_episodes")
    .select("id", { count: "exact", head: true })
    .eq("title_id", id)
    .eq("source", "instagram")
    .is("cover_image_url", null);

  // This invocation's batch (capped) — only still-null instagram episodes, in
  // episode order. The IS NULL filter is what makes a re-run skip populated rows.
  const { data: batchRows } = await supabase
    .from("title_episodes")
    .select("id, embed_url")
    .eq("title_id", id)
    .eq("source", "instagram")
    .is("cover_image_url", null)
    .order("episode_number", { ascending: true })
    .limit(PER_INVOCATION_CAP);
  const batch = (batchRows ?? []) as Array<{ id: string; embed_url: string }>;

  let enriched = 0;
  let failed = 0;
  for (let i = 0; i < batch.length; i += CONCURRENCY) {
    const slice = batch.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      slice.map((ep) => deriveAndStore(supabase, titleSlug, ep)),
    );
    for (const r of results) r === "ok" ? enriched++ : failed++;
  }

  if (enriched > 0) revalidatePath(`/t/${titleSlug}`);

  const remaining = Math.max(0, (totalNull ?? batch.length) - enriched);
  return NextResponse.json({
    ok: true,
    processed: batch.length,
    enriched,
    failed,
    remaining,
    via: authz.via,
  });
}
