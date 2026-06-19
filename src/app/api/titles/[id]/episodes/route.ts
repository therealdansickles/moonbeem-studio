// POST /api/titles/[id]/episodes — bulk-append Instagram episodes to a title's
// Watch tab. Net-new write path for title_episodes (it had a live READ path but
// no writer). Title-generic (NOT /api/admin) so owning-partner-admins are
// authorized via the OR gate. Instagram-source only in v1 (mux episodes arrive
// via the U2 ingest webhook — a different path).
//
// Authorization: authorizeTitleMutation(user.id, titleId) — super_admin OR the
// owning-partner-admin. Same gate + status mapping as the poster route.
//
// APPEND semantics: episode_number is assigned SERVER-SIDE as max+1.. in PASTE
// ORDER (the client never supplies it). So a second batch continues numbering
// and doesn't collide; the (title_id, episode_number) unique backstops races.

import { NextResponse, type NextRequest } from "next/server";
import { revalidatePath } from "next/cache";
import { getUser } from "@/lib/dal";
import { enforce } from "@/lib/ratelimit";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { authorizeTitleMutation } from "@/lib/auth/title-mutation";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Cap per batch — a paste can't insert unbounded rows. 39 (Watch Hill) fits.
const MAX_ITEMS = 100;

// Recognize an Instagram POST or REEL URL and rebuild the CANONICAL form,
// dropping query (?igsh=…/?utm=…) and fragment by reconstructing from the
// shortcode. Accepts p / reel / reels (reels→reel), with/without www/m,
// with/without trailing slash. Returns null for anything unrecognizable.
function normalizeInstagramUrl(raw: string): string | null {
  const trimmed = raw.trim();
  // Tolerate a pasted URL with no scheme (instagram.com/reel/… ).
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.toLowerCase().replace(/^m\./, "").replace(/^www\./, "");
  if (host !== "instagram.com") return null;
  const m = u.pathname.match(/^\/(p|reel|reels)\/([A-Za-z0-9_-]+)\/?$/i);
  if (!m) return null;
  const kind = m[1].toLowerCase() === "p" ? "p" : "reel";
  const shortcode = m[2];
  return `https://www.instagram.com/${kind}/${shortcode}/`;
}

type InItem = { url?: unknown; label?: unknown };

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getUser();
  if (!user) {
    return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  }
  const rl = await enforce("partnerWrites", user.id, "titles/episodes");
  if (!rl.ok) return rl.response;

  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "title_not_found" }, { status: 404 });
  }

  // AUTHORIZE FIRST — same gate + mapping as the poster route.
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

  let body: { items?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const rawItems = Array.isArray(body.items) ? (body.items as InItem[]) : null;
  if (!rawItems || rawItems.length === 0) {
    return NextResponse.json({ error: "empty_list" }, { status: 400 });
  }
  if (rawItems.length > MAX_ITEMS) {
    return NextResponse.json(
      { error: "too_many", max: MAX_ITEMS, got: rawItems.length },
      { status: 400 },
    );
  }

  const supabase = createServiceRoleClient();

  // Existing embed_urls for this title — soft dedup (no UNIQUE constraint in
  // v1; see recommendation in the report). Re-running an identical batch then
  // no-ops (all skipped) instead of double-adding.
  const { data: existingRows } = await supabase
    .from("title_episodes")
    .select("embed_url")
    .eq("title_id", id);
  const existing = new Set(
    (existingRows ?? []).map((r) => r.embed_url as string),
  );

  // Parse + validate + dedup, preserving paste order. errors are per-line
  // (1-based index); skipped = recognized-but-duplicate.
  const errors: Array<{ line: number; url: string; error: string }> = [];
  const skipped: Array<{ line: number; url: string; reason: string }> = [];
  const seenInBatch = new Set<string>();
  const toInsert: Array<{ embedUrl: string; label: string | null }> = [];

  rawItems.forEach((it, i) => {
    const line = i + 1;
    const rawUrl = typeof it.url === "string" ? it.url.trim() : "";
    const rawLabel =
      typeof it.label === "string" && it.label.trim() ? it.label.trim() : null;
    if (!rawUrl) {
      errors.push({ line, url: "", error: "missing_url" });
      return;
    }
    const canonical = normalizeInstagramUrl(rawUrl);
    if (!canonical) {
      errors.push({ line, url: rawUrl, error: "not_an_instagram_post_or_reel" });
      return;
    }
    if (seenInBatch.has(canonical) || existing.has(canonical)) {
      skipped.push({ line, url: canonical, reason: "already_present" });
      return;
    }
    seenInBatch.add(canonical);
    toInsert.push({ embedUrl: canonical, label: rawLabel });
  });

  if (toInsert.length === 0) {
    return NextResponse.json({ ok: true, added: 0, skipped, errors });
  }

  // Server-assigned numbering: max(episode_number)+1.. in paste order.
  const { data: maxRow } = await supabase
    .from("title_episodes")
    .select("episode_number")
    .eq("title_id", id)
    .order("episode_number", { ascending: false })
    .limit(1)
    .maybeSingle();
  const base = (maxRow?.episode_number as number | null) ?? 0;

  // Build rows. source='instagram' → embed_url set, mux fields untouched (null)
  // → satisfies title_episodes_source_shape_check. monetization_mode NULL
  // inherits the title default (Watch Hill: 'free') via the U1 COALESCE rule.
  const rows = toInsert.map((r, idx) => {
    const episodeNumber = base + idx + 1;
    return {
      title_id: id,
      episode_number: episodeNumber,
      label: r.label ?? `Episode ${episodeNumber}`,
      embed_url: r.embedUrl,
      source: "instagram",
      is_published: true,
      requires_drm: false,
      monetization_mode: null,
    };
  });

  // One atomic insert — all rows or none (a mid-batch failure won't leave a
  // half-added series). A 23505 means a concurrent batch took the numbers.
  const { data: inserted, error: insErr } = await supabase
    .from("title_episodes")
    .insert(rows)
    .select("id");
  if (insErr) {
    const conflict = insErr.code === "23505";
    return NextResponse.json(
      {
        error: conflict ? "numbering_conflict_retry" : insErr.message,
      },
      { status: conflict ? 409 : 500 },
    );
  }

  // Resolve the slug to revalidate the public Watch tab.
  const { data: title } = await supabase
    .from("titles")
    .select("slug")
    .eq("id", id)
    .maybeSingle();
  if (title?.slug) revalidatePath(`/t/${title.slug}`);

  return NextResponse.json({
    ok: true,
    added: inserted?.length ?? rows.length,
    first_episode_number: base + 1,
    last_episode_number: base + rows.length,
    skipped,
    errors,
    via: authz.via,
  });
}
