// Flow C — affiliate-link redirect.
//
// /go/<5-char-code> looks up the affiliate_links row by slug, logs a
// click, and 302-redirects to its destination_url with outbound UTMs
// appended. Soft-deleted links (deleted_at is not null) 404 — the row
// stays for historical click attribution but the link itself is dead.
//
// Runtime: Node (default). Vercel geo headers work on both runtimes
// per the runtime decision in Step 0; we picked Node for v1 to avoid
// double-novelty (new feature + new runtime).

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { appendOutboundUtms, logClick } from "@/lib/click-logger";

type Params = { params: Promise<{ code: string }> };

type AffiliateLinkRow = {
  id: string;
  creator_id: string | null;
  title_id: string;
  destination_url: string | null;
  creators: { moonbeem_handle: string } | null;
  titles: { slug: string } | null;
};

export async function GET(request: NextRequest, ctx: Params): Promise<Response> {
  const { code } = await ctx.params;

  const supabase = createServiceRoleClient();
  // TODO (next cycle): also select affiliate_links.title_offer_id and
  // pass it to logClick so Flow C clicks denormalize the offer
  // attribution onto external_clicks. Read-side analytics (top
  // offers per title) become single-table queries instead of joining
  // through affiliate_links every time.
  const { data, error } = await supabase
    .from("affiliate_links")
    .select(
      "id, creator_id, title_id, destination_url, " +
        "creators(moonbeem_handle), titles(slug)",
    )
    .eq("slug", code)
    .is("deleted_at", null)
    .maybeSingle();

  if (error) {
    console.error(`[go/code] lookup failed for slug=${code}: ${error.message}`);
    return new Response("Link lookup failed", {
      status: 500,
      headers: { "Content-Type": "text/plain" },
    });
  }
  // supabase-js's joined-select inference returns a wide error union;
  // after the error guard above we know data is the row shape (or null).
  const row = data as AffiliateLinkRow | null;
  if (!row || !row.destination_url) {
    return new Response("Link not found", {
      status: 404,
      headers: { "Content-Type": "text/plain" },
    });
  }

  const utms: Record<string, string> = {
    utm_source: "moonbeem",
    utm_medium: "fan_edit",
  };
  if (row.titles?.slug) utms.utm_campaign = row.titles.slug;
  if (row.creators?.moonbeem_handle) {
    utms.utm_content = row.creators.moonbeem_handle;
  }

  const finalUrl = appendOutboundUtms(row.destination_url, utms);

  await logClick({
    request,
    title_id: row.title_id,
    affiliate_link_id: row.id,
  });

  return NextResponse.redirect(finalUrl, 302);
}
