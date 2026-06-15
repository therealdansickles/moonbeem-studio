// Partner-admin endpoint for creating a campaign.
//
// POST /api/p/[slug]/campaigns
// Body: {
//   name: string,
//   title_ids: string[],      // 1+ UUIDs; each must belong to this partner
//   cpm_rate_cents: number,   // integer >= 1
//   budget_pool_cents: number,// integer > 0
//   starts_at?: string,       // optional ISO timestamp
//   ends_at?: string,         // optional ISO timestamp; must be after starts_at if both present
// }
// Auth: caller must be in partner_users with role='admin' for this
// partner. Viewer role cannot create. super_admin bypasses (mirrors
// the /p/[slug] page-level access pattern).
//
// On success the new row is born status='draft' with the schema's
// defaults for settling_days (7) and moonbeem_fee_pct (0.10). Those
// two columns are never read from the request body — sub-slice 3a is
// money-free and the partner cannot override either knob.
//
// Multi-table write strategy: this endpoint inserts a campaigns row
// and N campaign_titles rows. There is no existing RPC pattern in the
// project for client-driven multi-table writes (the only multi-table
// RPC is mark_social_verified_and_merge, an internal verification
// flow). Adding a new RPC for a single create call is more schema
// weight than the case warrants. Instead: insert the campaign first,
// then batch-insert campaign_titles. If the titles insert fails, the
// just-created campaigns row is deleted as a compensating action so
// no orphan draft leaks. The window where a half-applied write could
// be observed is small (the gap between the two inserts on a single
// request), and a draft is inert (no metering, no payouts), so even
// in the unlikely failure case the user sees an error and can retry.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentProfile, getUser } from "@/lib/dal";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { enforce } from "@/lib/ratelimit";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME_MAX_LENGTH = 200;
// Hard cap on client-supplied title_ids per campaign. Rejects abusive/oversized
// input at the route boundary BEFORE the ownership .in() query, so an unbounded
// `id=in.(...)` URL can never be built (100 uuids ~= 3.7KB, well under the
// gateway cap -> the single .in() stays safe with no chunking). Generous vs any
// realistic campaign (live max is 1 title/campaign). A cap (reject), NOT
// chunking: chunking abusive external input would just make the abuse efficient.
const MAX_TITLES_PER_CAMPAIGN = 100;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const user = await getUser();
  if (!user) {
    return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  }
  const limit = await enforce("partnerWrites", user.id, "p/campaigns");
  if (!limit.ok) return limit.response;
  const { slug } = await params;
  const supabase = createServiceRoleClient();

  const { data: partner } = await supabase
    .from("partners")
    .select("id")
    .eq("slug", slug)
    .maybeSingle();
  if (!partner) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // super_admin bypasses partner_users check (matches /p/[slug]
  // page-level access). Otherwise the caller must be a partner_users
  // member with role='admin'. Viewer-role partner_users cannot create.
  const profile = await getCurrentProfile();
  if (profile?.role !== "super_admin") {
    const { data: membership } = await supabase
      .from("partner_users")
      .select("role")
      .eq("partner_id", partner.id)
      .eq("user_id", user.id)
      .is("deleted_at", null)
      .maybeSingle();
    if (!membership || membership.role !== "admin") {
      return NextResponse.json({ error: "not_authorized" }, { status: 403 });
    }
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const b = body as Record<string, unknown>;

  // name
  const nameRaw = b.name;
  const name = typeof nameRaw === "string" ? nameRaw.trim() : "";
  if (name.length === 0 || name.length > NAME_MAX_LENGTH) {
    return NextResponse.json({ error: "invalid_name" }, { status: 400 });
  }

  // title_ids
  const titleIdsRaw = b.title_ids;
  if (!Array.isArray(titleIdsRaw) || titleIdsRaw.length === 0) {
    return NextResponse.json({ error: "invalid_title_ids" }, { status: 400 });
  }
  const titleIds: string[] = [];
  for (const t of titleIdsRaw) {
    if (typeof t !== "string" || !UUID_RE.test(t)) {
      return NextResponse.json({ error: "invalid_title_ids" }, { status: 400 });
    }
    titleIds.push(t);
  }
  // De-dupe defensively so a noisy client can't try to bypass the
  // unique (campaign_id, title_id) constraint with repeated ids.
  const uniqueTitleIds = Array.from(new Set(titleIds));

  // Cap the deduped set BEFORE the ownership .in() query at the bottom of this
  // handler. Without this, an oversized title_ids array builds a multi-KB
  // `id=in.(...)` URL that overflows the gateway (the .in() trap). Reject
  // oversized input here rather than letting it fall through to a confusing
  // 500 / count-mismatch 400. >MAX rejects; ==MAX and below proceed.
  if (uniqueTitleIds.length > MAX_TITLES_PER_CAMPAIGN) {
    return NextResponse.json(
      { error: "too_many_titles", max_titles: MAX_TITLES_PER_CAMPAIGN },
      { status: 400 },
    );
  }

  // cpm_rate_cents — integer >= 1. A 0-cent CPM means no payouts,
  // which contradicts having a budget pool; if the partner wants to
  // pause they pause the campaign (3b/3c lifecycle), not create at 0.
  const cpmRaw = b.cpm_rate_cents;
  const cpm = typeof cpmRaw === "number" ? Math.round(cpmRaw) : NaN;
  if (!Number.isFinite(cpm) || !Number.isInteger(cpm) || cpm < 1) {
    return NextResponse.json({ error: "invalid_cpm_rate" }, { status: 400 });
  }

  // budget_pool_cents — integer > 0.
  const budgetRaw = b.budget_pool_cents;
  const budget = typeof budgetRaw === "number" ? Math.round(budgetRaw) : NaN;
  if (!Number.isFinite(budget) || !Number.isInteger(budget) || budget <= 0) {
    return NextResponse.json({ error: "invalid_budget" }, { status: 400 });
  }

  // starts_at / ends_at — optional. If present, must parse as Date.
  // If both present, ends_at strictly after starts_at.
  let startsAtIso: string | null = null;
  let endsAtIso: string | null = null;
  if (b.starts_at !== undefined && b.starts_at !== null && b.starts_at !== "") {
    if (typeof b.starts_at !== "string") {
      return NextResponse.json({ error: "invalid_dates" }, { status: 400 });
    }
    const d = new Date(b.starts_at);
    if (Number.isNaN(d.getTime())) {
      return NextResponse.json({ error: "invalid_dates" }, { status: 400 });
    }
    startsAtIso = d.toISOString();
  }
  if (b.ends_at !== undefined && b.ends_at !== null && b.ends_at !== "") {
    if (typeof b.ends_at !== "string") {
      return NextResponse.json({ error: "invalid_dates" }, { status: 400 });
    }
    const d = new Date(b.ends_at);
    if (Number.isNaN(d.getTime())) {
      return NextResponse.json({ error: "invalid_dates" }, { status: 400 });
    }
    endsAtIso = d.toISOString();
  }
  if (startsAtIso && endsAtIso && new Date(endsAtIso) <= new Date(startsAtIso)) {
    return NextResponse.json({ error: "invalid_dates" }, { status: 400 });
  }

  // brief — optional free text shown on the public campaign page (CF-2).
  // Display-only: no money path reads it. Trim; empty → null; cap 2000
  // (mirrors the campaigns.brief CHECK). Non-string → 400.
  let brief: string | null = null;
  if (b.brief !== undefined && b.brief !== null) {
    if (typeof b.brief !== "string") {
      return NextResponse.json({ error: "invalid_brief" }, { status: 400 });
    }
    const trimmedBrief = b.brief.trim();
    if (trimmedBrief.length > 2000) {
      return NextResponse.json({ error: "brief_too_long" }, { status: 400 });
    }
    brief = trimmedBrief.length > 0 ? trimmedBrief : null;
  }

  // Per-title ownership check — every id must point at a titles row
  // owned by THIS partner with deleted_at IS NULL. One batched query
  // confirms the whole set; a count mismatch means at least one id
  // failed (wrong partner, deleted, or non-existent). Without this,
  // a partner-admin could attach another partner's titles.
  const { data: ownedTitles, error: ownErr } = await supabase
    .from("titles")
    .select("id")
    .in("id", uniqueTitleIds)
    .eq("partner_id", partner.id)
    .is("deleted_at", null);
  if (ownErr) {
    return NextResponse.json({ error: ownErr.message }, { status: 500 });
  }
  if ((ownedTitles ?? []).length !== uniqueTitleIds.length) {
    return NextResponse.json(
      { error: "title_not_in_partner" },
      { status: 400 },
    );
  }

  // Insert the campaign row. Defaults: status='draft',
  // settling_days=7, moonbeem_fee_pct=0.10, created_at/updated_at.
  const { data: created, error: insertErr } = await supabase
    .from("campaigns")
    .insert({
      partner_id: partner.id,
      name,
      brief,
      cpm_rate_cents: cpm,
      budget_pool_cents: budget,
      starts_at: startsAtIso,
      ends_at: endsAtIso,
      created_by_user_id: user.id,
    })
    .select("id")
    .single();
  if (insertErr || !created) {
    return NextResponse.json(
      { error: insertErr?.message ?? "campaign_insert_failed" },
      { status: 500 },
    );
  }
  const campaignId = created.id as string;

  // Insert campaign_titles rows. On failure, delete the just-created
  // campaign so we don't leak an orphan draft.
  const titleRows = uniqueTitleIds.map((title_id) => ({
    campaign_id: campaignId,
    title_id,
  }));
  const { error: titlesErr } = await supabase
    .from("campaign_titles")
    .insert(titleRows);
  if (titlesErr) {
    // Compensating delete. If even this fails, the orphan draft sits
    // on the partner with no campaign_titles — visible in their list
    // as a campaign with 0 titles, recoverable by deleting in a
    // future admin tool. Log loudly so it's not silent.
    const { error: cleanupErr } = await supabase
      .from("campaigns")
      .delete()
      .eq("id", campaignId);
    if (cleanupErr) {
      console.error(
        `[campaigns] compensating delete failed for campaign=${campaignId} after titles insert failure: ${cleanupErr.message}`,
      );
    }
    return NextResponse.json(
      { error: titlesErr.message },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    campaign_id: campaignId,
    partner_id: partner.id,
    title_count: uniqueTitleIds.length,
  });
}
