// GET /go/title — internal attribution redirect for profile Top-12 clicks.
//
// /go/title?via=<creator_id>&slug=<title-slug>
//   - VALIDATES `via` is a real CLAIMED creator (is_claimed + non-null user_id +
//     not deleted) BEFORE writing any cookie — never attribute to a bad creator.
//   - Resolves the title from `slug`; an unresolved slug gets NO cookie (don't
//     point attribution at a non-title — the /t page 404s on its own).
//   - On a valid (creator, title): sets the first-party `mb_aff` cookie (7-day
//     TTL, last-click overwrite) carrying {creator_id, title_id, ts}, logs an
//     ATTRIBUTED external_clicks row (creator_id included — closes the
//     unattributed-click gap), then 302s to /t/<slug>.
//   - Always lands the fan on /t/<slug>; attribution is best-effort and never
//     blocks the redirect.
//
// The `mb_aff` cookie is HttpOnly: it is READ only server-side (the rent route
// reads it via request.cookies at checkout), never by client JS. Runtime: Node
// (default), matching /go/offer + /go/[code].

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { getTitleBySlug } from "@/lib/queries/titles";
import { logClick } from "@/lib/click-logger";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MB_AFF_MAX_AGE_S = 604800; // 7 days

export async function GET(request: NextRequest): Promise<Response> {
  const via = request.nextUrl.searchParams.get("via");
  const slug = request.nextUrl.searchParams.get("slug");

  // No slug → nothing to land on; send home, no cookie.
  if (!slug) {
    return NextResponse.redirect(new URL("/", request.url), 302);
  }

  // We always redirect the fan to the title page; the cookie is added below only
  // when (creator, title) both validate.
  const dest = NextResponse.redirect(new URL(`/t/${slug}`, request.url), 302);

  // A slug that doesn't resolve to a title, or a missing/malformed via → no
  // cookie (don't store attribution pointing at nothing).
  const title = await getTitleBySlug(slug);
  if (!title || !via || !UUID_RE.test(via)) {
    return dest;
  }

  // VALIDATE `via` is a real, CLAIMED creator BEFORE setting any cookie.
  const supabase = createServiceRoleClient();
  const { data: creator } = await supabase
    .from("creators")
    .select("user_id")
    .eq("id", via)
    .eq("is_claimed", true)
    .not("user_id", "is", null)
    .is("deleted_at", null)
    .maybeSingle();
  if (!creator) {
    return dest; // invalid / unclaimed via → no cookie
  }

  // Valid (creator, title) → set the attribution cookie (last-click: each new
  // click overwrites) and log the attributed click. Both best-effort.
  dest.cookies.set(
    "mb_aff",
    JSON.stringify({
      creator_id: via,
      title_id: title.id as string,
      ts: Date.now(),
    }),
    {
      maxAge: MB_AFF_MAX_AGE_S,
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: true,
    },
  );

  try {
    await logClick({
      request,
      title_id: title.id as string,
      creator_id: via,
    });
  } catch {
    // best-effort: the redirect + cookie already stand
  }

  return dest;
}
