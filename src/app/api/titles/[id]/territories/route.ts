// PATCH /api/titles/[id]/territories — set a title's playback territory rights.
//
// Title-scoped (NOT /api/admin), so owning-partner-admins are authorized via the
// OR gate — mirrors PATCH /api/titles/[id]/metadata exactly (getUser ->
// enforce("partnerWrites") -> UUID -> authorizeTitleMutation -> service-role
// update -> select-confirm -> revalidate). Body:
//   { allowed_territories: string[], territory_worldwide: boolean }
//
// COHERENCE RULE (state is always unambiguous — a non-null allowed_territories
// ALWAYS means "restricted to exactly these"):
//   - territory_worldwide=true  -> store { worldwide:true,  allowed_territories: null }
//       (worldwide supersedes; the list is cleared so the two never disagree)
//   - worldwide=false + codes   -> store { worldwide:false, allowed_territories: [CODES] }
//   - worldwide=false + empty   -> store { worldwide:false, allowed_territories: null }
//       (the unset / default-deny state — a partner may save this, but the publish
//        route's no_territories_set guard then blocks go-live)
// Codes are validated uppercase alpha-2 against the known set; unknown -> 400.
// Presentation/playback-rights only — no money rail, no Mux/upload change.

import { NextResponse, type NextRequest } from "next/server";
import { revalidatePath } from "next/cache";
import { getUser } from "@/lib/dal";
import { enforce } from "@/lib/ratelimit";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { authorizeTitleMutation } from "@/lib/auth/title-mutation";
import { ALL_COUNTRY_CODES } from "@/lib/playback/countries";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getUser();
  if (!user) {
    return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  }
  const rl = await enforce("partnerWrites", user.id, "titles/territories");
  if (!rl.ok) return rl.response;

  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "title_not_found" }, { status: 404 });
  }

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

  let body: { allowed_territories?: unknown; territory_worldwide?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const worldwide = body.territory_worldwide === true;

  // Validate + normalize the allow-list (only when not worldwide).
  let list: string[] = [];
  if (!worldwide && body.allowed_territories != null) {
    if (!Array.isArray(body.allowed_territories)) {
      return NextResponse.json(
        { error: "invalid_territories" },
        { status: 400 },
      );
    }
    const codes = body.allowed_territories.map((c) =>
      typeof c === "string" ? c.trim().toUpperCase() : "",
    );
    const unknown = [...new Set(codes)].filter(
      (c) => !ALL_COUNTRY_CODES.has(c),
    );
    if (unknown.length > 0) {
      return NextResponse.json(
        { error: "unknown_country", codes: unknown },
        { status: 400 },
      );
    }
    list = [...new Set(codes)]; // dedupe, keep insertion order
  }

  // Apply the coherence rule.
  const update: {
    territory_worldwide: boolean;
    allowed_territories: string[] | null;
  } = worldwide
    ? { territory_worldwide: true, allowed_territories: null }
    : {
        territory_worldwide: false,
        allowed_territories: list.length > 0 ? list : null,
      };

  const supabase = createServiceRoleClient();
  const { data: updated, error } = await supabase
    .from("titles")
    .update(update)
    .eq("id", id)
    .select("id, slug, allowed_territories, territory_worldwide")
    .maybeSingle();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!updated) {
    return NextResponse.json({ error: "title_not_found" }, { status: 404 });
  }

  // Territory is read live on every token mint, but revalidate the title page to
  // drop any router/CDN cache.
  revalidatePath(`/t/${updated.slug as string}`);

  return NextResponse.json({
    ok: true,
    titleId: updated.id,
    territory_worldwide: updated.territory_worldwide,
    allowed_territories:
      (updated.allowed_territories as string[] | null) ?? [],
  });
}
