// PATCH /api/titles/[id]/metadata — edit a created title's core rendered
// metadata (the 5 fields the About tab actually reads). Net-new, title-scoped
// (NOT /api/admin), so owning-partner-admins are authorized via the OR gate —
// mirrors the poster route, NOT an extension of the super-admin-only
// /api/admin/titles/[slug].
//
// Presentation/metadata-only, money-rail-free, Mux-independent. Partial PATCH:
// only provided fields are written (editing just the synopsis leaves the rest).
//
// Authorization: authorizeTitleMutation(user.id, titleId) — super_admin OR the
// owning-partner-admin. Same 401/404/403 mapping as poster/episodes/thumbnails.

import { NextResponse, type NextRequest } from "next/server";
import { revalidatePath } from "next/cache";
import { getUser } from "@/lib/dal";
import { enforce } from "@/lib/ratelimit";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { authorizeTitleMutation } from "@/lib/auth/title-mutation";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// EXACTLY the 5 rendered + in-Title-type fields. tagline/overview/genres are
// DEAD columns (rendered by nothing) and are NOT accepted — an unknown field in
// the body is rejected, not silently dropped. runtime_min (not the dead
// runtime_mins duplicate) is the one the About meta line reads.
const ALLOWED_FIELDS = new Set([
  "synopsis",
  "year",
  "runtime_min",
  "director",
  "starring_csv",
]);

const MAX_SYNOPSIS = 2000;
const MAX_DIRECTOR = 500;
const MAX_STARRING = 500;
const MIN_YEAR = 1888; // first film
const MAX_YEAR = new Date().getFullYear() + 1; // allow next-year announcements

// Free-text: trim, cap length, empty → NULL. Returns the value or an error code.
function cleanText(
  raw: unknown,
  max: number,
): { ok: true; value: string | null } | { ok: false } {
  if (raw === null) return { ok: true, value: null };
  if (typeof raw !== "string") return { ok: false };
  const t = raw.trim();
  if (t.length === 0) return { ok: true, value: null };
  if (t.length > max) return { ok: false };
  return { ok: true, value: t };
}

// Integer in [min,max], or null when explicitly cleared. Rejects non-integers
// and out-of-range. Accepts a numeric string (form inputs) or a number.
function cleanInt(
  raw: unknown,
  min: number,
  max: number,
): { ok: true; value: number | null } | { ok: false } {
  if (raw === null || raw === "") return { ok: true, value: null };
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) return { ok: false };
  return { ok: true, value: n };
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getUser();
  if (!user) {
    return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  }
  const rl = await enforce("partnerWrites", user.id, "titles/metadata");
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

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  // Reject unknown fields (don't silently accept tagline/etc.).
  const keys = Object.keys(body);
  const unknown = keys.filter((k) => !ALLOWED_FIELDS.has(k));
  if (unknown.length > 0) {
    return NextResponse.json(
      { error: "unknown_field", fields: unknown },
      { status: 400 },
    );
  }
  if (keys.length === 0) {
    return NextResponse.json({ error: "no_fields" }, { status: 400 });
  }

  // Build the update from ONLY the provided fields (partial PATCH).
  const update: Record<string, string | number | null> = {};

  if ("synopsis" in body) {
    const r = cleanText(body.synopsis, MAX_SYNOPSIS);
    if (!r.ok) return NextResponse.json({ error: "invalid_synopsis" }, { status: 400 });
    update.synopsis = r.value;
  }
  if ("director" in body) {
    const r = cleanText(body.director, MAX_DIRECTOR);
    if (!r.ok) return NextResponse.json({ error: "invalid_director" }, { status: 400 });
    update.director = r.value;
  }
  if ("starring_csv" in body) {
    const r = cleanText(body.starring_csv, MAX_STARRING);
    if (!r.ok) return NextResponse.json({ error: "invalid_starring_csv" }, { status: 400 });
    update.starring_csv = r.value;
  }
  if ("year" in body) {
    const r = cleanInt(body.year, MIN_YEAR, MAX_YEAR);
    if (!r.ok) return NextResponse.json({ error: "invalid_year" }, { status: 400 });
    update.year = r.value;
  }
  if ("runtime_min" in body) {
    const r = cleanInt(body.runtime_min, 1, 100000);
    if (!r.ok) return NextResponse.json({ error: "invalid_runtime_min" }, { status: 400 });
    update.runtime_min = r.value;
  }

  // Write via service-role (authorization already enforced in-app). Scope by PK.
  const supabase = createServiceRoleClient();
  const { data: updated, error } = await supabase
    .from("titles")
    .update(update)
    .eq("id", id)
    .select("id, slug, synopsis, year, runtime_min, director, starring_csv")
    .maybeSingle();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!updated) {
    return NextResponse.json({ error: "title_not_found" }, { status: 404 });
  }

  // The About tab reads live (no static cache / revalidate on /t/[slug]), so
  // this isn't strictly required — but revalidate to drop any CDN/router cache.
  revalidatePath(`/t/${updated.slug}`);

  return NextResponse.json({ ok: true, title: updated, via: authz.via });
}
