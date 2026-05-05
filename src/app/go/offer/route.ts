// Flows A + B — direct offer-button click.
//
// /go/offer?title_id=X&title_offer_id=Y[&creator_id=Z]
//   - Flow A: no creator_id → anonymous title-page offer click
//   - Flow B: with creator_id → click attributed to a creator's
//     Top 12 / profile surface
//
// Looks up the title_offer, sanity-checks it belongs to the title_id
// param, logs a click, 302-redirects to provider_url with outbound
// UTMs that distinguish Flow A vs B (utm_medium=offer_button vs
// utm_medium=top_12).
//
// Runtime: Node (default).

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { appendOutboundUtms, logClick } from "@/lib/click-logger";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: NextRequest): Promise<Response> {
  const url = new URL(request.url);
  const title_id = url.searchParams.get("title_id");
  const title_offer_id = url.searchParams.get("title_offer_id");
  const creator_id = url.searchParams.get("creator_id");

  if (!title_id || !UUID_RE.test(title_id)) {
    return new Response("Invalid or missing title_id", {
      status: 400,
      headers: { "Content-Type": "text/plain" },
    });
  }
  if (!title_offer_id || !UUID_RE.test(title_offer_id)) {
    return new Response("Invalid or missing title_offer_id", {
      status: 400,
      headers: { "Content-Type": "text/plain" },
    });
  }
  if (creator_id && !UUID_RE.test(creator_id)) {
    return new Response("Invalid creator_id", {
      status: 400,
      headers: { "Content-Type": "text/plain" },
    });
  }

  type OfferRow = {
    id: string;
    title_id: string;
    provider_url: string | null;
    titles: { slug: string } | null;
  };

  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from("title_offers")
    .select("id, title_id, provider_url, titles(slug)")
    .eq("id", title_offer_id)
    .maybeSingle();

  if (error) {
    console.error(
      `[go/offer] lookup failed for title_offer_id=${title_offer_id}: ${error.message}`,
    );
    return new Response("Offer lookup failed", {
      status: 500,
      headers: { "Content-Type": "text/plain" },
    });
  }
  const offer = data as OfferRow | null;
  if (!offer || !offer.provider_url) {
    return new Response("Offer not found", {
      status: 404,
      headers: { "Content-Type": "text/plain" },
    });
  }
  // Sanity: the offer must belong to the title we were told it does.
  // Catches stale links + any caller-side mistake. 404 not 400 — from
  // the user's POV this is a dead link, not a malformed request.
  if (offer.title_id !== title_id) {
    console.warn(
      `[go/offer] title_id mismatch: param=${title_id} ` +
        `offer.title_id=${offer.title_id}`,
    );
    return new Response("Offer not found", {
      status: 404,
      headers: { "Content-Type": "text/plain" },
    });
  }

  let creatorHandle: string | null = null;
  if (creator_id) {
    const { data: creatorData } = await supabase
      .from("creators")
      .select("moonbeem_handle")
      .eq("id", creator_id)
      .maybeSingle();
    const creator = creatorData as { moonbeem_handle: string } | null;
    if (creator?.moonbeem_handle) {
      creatorHandle = creator.moonbeem_handle;
    }
  }

  const utms: Record<string, string> = {
    utm_source: "moonbeem",
    utm_medium: creator_id ? "top_12" : "offer_button",
  };
  if (offer.titles?.slug) utms.utm_campaign = offer.titles.slug;
  utms.utm_content = creatorHandle ?? offer.id;

  const finalUrl = appendOutboundUtms(offer.provider_url, utms);

  await logClick({
    request,
    title_id,
    title_offer_id,
    creator_id: creator_id || null,
  });

  return NextResponse.redirect(finalUrl, 302);
}
