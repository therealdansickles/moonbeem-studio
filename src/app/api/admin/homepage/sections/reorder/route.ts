// POST /api/admin/homepage/sections/reorder — super-admin lateral
// order of the homepage carousel sections. Mechanical clone of
// /api/admin/fan-edits/recent/reorder shape, simplified because the
// homepage_sections taxonomy is a fixed five-slug set (no pinned /
// hidden distinction, no per-entity backstop — the slug CHECK
// constraint locks the known set at the schema layer).
//
// Body shape:
//   { order: HomepageSectionSlug[] }   // exactly N slugs, no dups
//
// Two-phase write (TEMP_OFFSET=10_000) keeps the update collision-
// free and future-proofs a potential UNIQUE on display_order.
// revalidatePath("/") on success.

import { NextResponse, type NextRequest } from "next/server";
import { revalidatePath } from "next/cache";
import { requireSuperAdmin } from "@/lib/dal";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { enforce } from "@/lib/ratelimit";
import {
  HOMEPAGE_SECTION_SLUGS,
  type HomepageSectionSlug,
} from "@/lib/homepage-sections";

const TEMP_OFFSET = 10_000;

export async function POST(request: NextRequest) {
  const session = await requireSuperAdmin();
  const limit = await enforce(
    "admin",
    session.userId,
    "admin/homepage/sections/reorder",
  );
  if (!limit.ok) return limit.response;

  let body: { order?: unknown };
  try {
    body = (await request.json()) as { order?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const rawOrder = Array.isArray(body.order) ? body.order : null;
  if (!rawOrder) {
    return NextResponse.json({ error: "invalid_order" }, { status: 400 });
  }
  if (rawOrder.length !== HOMEPAGE_SECTION_SLUGS.length) {
    return NextResponse.json(
      {
        error: "wrong_count",
        expected: HOMEPAGE_SECTION_SLUGS.length,
        got: rawOrder.length,
      },
      { status: 400 },
    );
  }

  const knownSlugs = new Set<string>(HOMEPAGE_SECTION_SLUGS);
  const seen = new Set<string>();
  const order: HomepageSectionSlug[] = [];
  for (const v of rawOrder) {
    if (typeof v !== "string") {
      return NextResponse.json(
        { error: "invalid_slug_type" },
        { status: 400 },
      );
    }
    if (!knownSlugs.has(v)) {
      return NextResponse.json(
        { error: "unknown_slug", slug: v },
        { status: 400 },
      );
    }
    if (seen.has(v)) {
      return NextResponse.json(
        { error: "duplicate_slug", slug: v },
        { status: 400 },
      );
    }
    seen.add(v);
    order.push(v as HomepageSectionSlug);
  }

  const supabase = createServiceRoleClient();

  // Two-phase write — bump every row to a high temporary range so
  // the final write can collide-free assign 1..N.
  for (let i = 0; i < order.length; i++) {
    const { error } = await supabase
      .from("homepage_sections")
      .update({ display_order: TEMP_OFFSET + i })
      .eq("slug", order[i]);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
  }
  for (let i = 0; i < order.length; i++) {
    const { error } = await supabase
      .from("homepage_sections")
      .update({ display_order: i + 1 })
      .eq("slug", order[i]);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
  }

  revalidatePath("/");
  return NextResponse.json({ success: true });
}
