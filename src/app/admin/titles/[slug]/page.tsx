// /admin/titles/[slug] — operational hub for a single title.
//
// Super-admin only. The page is the single landing for everything
// scoped to one title: fan edits (with delete), uploads (CSV fan
// edits + clips/stills), and settings (status flags, partner
// attribution).
//
// Reads via service-role; the underlying tables (fan_edits,
// titles, partners) all use the cookie-aware client elsewhere but
// admin needs to see soft-deleted rows for restore/audit.

import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { requireSuperAdminOr404 } from "@/lib/dal";
import { createServiceRoleClient } from "@/lib/supabase/service";
import {
  parseWindow,
  windowCutoffIso,
  bucketTimeSeries,
  countByState,
  countByCity,
} from "@/lib/dashboard/queries";
import TitleDetailTabs, {
  type AnalyticsData,
  type ClipRow,
  type FanEditRow,
  type StillRow,
} from "./TitleDetailTabs";

type PageProps = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ tab?: string; window?: string | string[] }>;
};

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { slug } = await params;
  return {
    title: `${slug} · admin · Moonbeem`,
    robots: { index: false, follow: false },
  };
}

const ALLOWED_TABS = [
  "fan-edits",
  "clips",
  "stills",
  "discover",
  "analytics",
  "upload",
  "settings",
] as const;
type Tab = (typeof ALLOWED_TABS)[number];

function parseTab(raw: string | undefined): Tab {
  if (raw && (ALLOWED_TABS as readonly string[]).includes(raw)) {
    return raw as Tab;
  }
  return "fan-edits";
}

export default async function AdminTitleDetailPage({
  params,
  searchParams,
}: PageProps) {
  await requireSuperAdminOr404();
  const { slug } = await params;
  const { tab, window: windowParam } = await searchParams;
  const activeTab = parseTab(tab);
  const activeWindow = parseWindow(windowParam);

  // Catch the bare /admin/titles route by way of typo / stale link.
  if (!slug || slug === "_") redirect("/admin");

  const supabase = createServiceRoleClient();
  const { data: title, error: titleErr } = await supabase
    .from("titles")
    .select(
      "id, slug, title, is_active, is_public, partner_id, deleted_at, partners:partner_id(name, slug)",
    )
    .eq("slug", slug)
    .maybeSingle();
  if (titleErr) {
    throw new Error(`title load failed: ${titleErr.message}`);
  }
  if (!title) notFound();

  const t = title as unknown as {
    id: string;
    slug: string;
    title: string;
    is_active: boolean;
    is_public: boolean;
    partner_id: string | null;
    deleted_at: string | null;
    partners: { name: string; slug: string } | null;
  };

  const { data: edits, error: editsErr } = await supabase
    .from("fan_edits")
    .select(
      "id, platform, embed_url, caption, view_count, like_count, posted_at, thumbnail_url, creator_id, creator_handle_displayed, deleted_at, created_at",
    )
    .eq("title_id", t.id)
    .order("created_at", { ascending: false });
  if (editsErr) {
    throw new Error(`fan_edits load failed: ${editsErr.message}`);
  }
  const editRows = (edits ?? []) as Array<{
    id: string;
    platform: string;
    embed_url: string | null;
    caption: string | null;
    view_count: number | null;
    like_count: number | null;
    posted_at: string | null;
    thumbnail_url: string | null;
    creator_id: string | null;
    creator_handle_displayed: string | null;
    deleted_at: string | null;
    created_at: string;
  }>;

  // Resolve creator handles via public_creators (RLS-readable view).
  const creatorIds = Array.from(
    new Set(
      editRows
        .map((e) => e.creator_id)
        .filter((id): id is string => !!id),
    ),
  );
  const handleById = new Map<string, string>();
  if (creatorIds.length > 0) {
    const { data: creators } = await supabase
      .from("public_creators")
      .select("id, moonbeem_handle")
      .in("id", creatorIds);
    for (const c of creators ?? []) {
      handleById.set(c.id as string, c.moonbeem_handle as string);
    }
  }

  const fanEdits: FanEditRow[] = editRows.map((e) => ({
    id: e.id,
    platform: e.platform,
    embed_url: e.embed_url,
    caption: e.caption,
    view_count: e.view_count ?? 0,
    like_count: e.like_count ?? 0,
    posted_at: e.posted_at,
    thumbnail_url: e.thumbnail_url,
    creator_handle: e.creator_id
      ? handleById.get(e.creator_id) ?? null
      : e.creator_handle_displayed ?? null,
    moonbeem_handle: e.creator_id
      ? handleById.get(e.creator_id) ?? null
      : null,
    deleted_at: e.deleted_at,
    created_at: e.created_at,
  }));

  // Admin sees all clips/stills including soft-deleted (audit /
  // restore). Public RLS on the tables handles user-facing exclusion.
  const [clipsRes, stillsRes] = await Promise.all([
    supabase
      .from("clips")
      .select(
        "id, file_url, thumbnail_url, label, content_type, duration_seconds, file_size_bytes, display_order, deleted_at, created_at",
      )
      .eq("title_id", t.id)
      .order("display_order", { ascending: true }),
    supabase
      .from("stills")
      .select(
        "id, file_url, thumbnail_url, alt_text, content_type, file_size_bytes, width, height, display_order, deleted_at, created_at",
      )
      .eq("title_id", t.id)
      .order("display_order", { ascending: true }),
  ]);
  if (clipsRes.error) {
    throw new Error(`clips load failed: ${clipsRes.error.message}`);
  }
  if (stillsRes.error) {
    throw new Error(`stills load failed: ${stillsRes.error.message}`);
  }
  const clips: ClipRow[] = (clipsRes.data ?? []).map((c) => ({
    id: c.id as string,
    file_url: (c.file_url as string | null) ?? null,
    thumbnail_url: (c.thumbnail_url as string | null) ?? null,
    label: (c.label as string | null) ?? null,
    content_type: (c.content_type as string | null) ?? null,
    duration_seconds:
      typeof c.duration_seconds === "string"
        ? Number(c.duration_seconds)
        : (c.duration_seconds as number | null) ?? null,
    file_size_bytes: (c.file_size_bytes as number | null) ?? null,
    display_order: (c.display_order as number | null) ?? 0,
    deleted_at: (c.deleted_at as string | null) ?? null,
    created_at: c.created_at as string,
  }));
  const stills: StillRow[] = (stillsRes.data ?? []).map((s) => ({
    id: s.id as string,
    file_url: (s.file_url as string | null) ?? null,
    thumbnail_url: (s.thumbnail_url as string | null) ?? null,
    alt_text: (s.alt_text as string | null) ?? null,
    content_type: (s.content_type as string | null) ?? null,
    file_size_bytes: (s.file_size_bytes as number | null) ?? null,
    width: (s.width as number | null) ?? null,
    height: (s.height as number | null) ?? null,
    display_order: (s.display_order as number | null) ?? 0,
    deleted_at: (s.deleted_at as string | null) ?? null,
    created_at: s.created_at as string,
  }));

  // Partners list for the Settings tab's partner picker. Cheap
  // (one row per partner), plus we already need this elsewhere on
  // /admin so caching policy isn't a concern.
  const { data: allPartnersRaw } = await supabase
    .from("partners")
    .select("id, slug, name")
    .order("name");
  const allPartners = (allPartnersRaw ?? []) as Array<{
    id: string;
    slug: string;
    name: string;
  }>;

  // Analytics data — only fetched when the user is on (or landing on)
  // the Analytics tab. Tab switches are client-side router.replace,
  // which re-runs this server page; switching to ?tab=analytics here
  // triggers the fetch on demand and other tabs stay cheap.
  const analytics: AnalyticsData | null =
    activeTab === "analytics"
      ? await buildAnalyticsData(supabase, t.id, activeWindow)
      : null;

  return (
    <TitleDetailTabs
      titleId={t.id}
      titleSlug={t.slug}
      titleName={t.title}
      isActive={t.is_active}
      isPublic={t.is_public}
      partnerId={t.partner_id}
      partnerName={t.partners?.name ?? null}
      partnerSlug={t.partners?.slug ?? null}
      hasPartner={!!t.partner_id}
      allPartners={allPartners}
      fanEdits={fanEdits}
      clips={clips}
      stills={stills}
      activeTab={activeTab}
      activeWindow={activeWindow}
      analytics={analytics}
    />
  );
}

async function buildAnalyticsData(
  supabase: ReturnType<typeof createServiceRoleClient>,
  titleId: string,
  win: ReturnType<typeof parseWindow>,
): Promise<AnalyticsData> {
  const cutoff = windowCutoffIso(win);

  const fanEditsForTitleQ = supabase
    .from("fan_edits")
    .select(
      "id, platform, embed_url, caption, view_count, creator_id, creator_handle_displayed, thumbnail_url",
    )
    .eq("title_id", titleId)
    .eq("is_active", true)
    .eq("verification_status", "auto_verified")
    .is("deleted_at", null)
    .order("view_count", { ascending: false, nullsFirst: false });

  const openRequestsCountQ = supabase
    .from("title_requests")
    .select("id", { count: "exact", head: true })
    .eq("title_id", titleId)
    .is("fulfilled_at", null)
    .eq("request_type", "fan_edits");

  const clicksQ = (() => {
    let q = supabase
      .from("external_clicks")
      .select("country_code, region_code, city, clicked_at")
      .eq("title_id", titleId)
      .eq("is_bot", false);
    if (cutoff) q = q.gte("clicked_at", cutoff);
    return q;
  })();

  const [fanEditsRes, openRequestsRes, clicksRes] = await Promise.all([
    fanEditsForTitleQ,
    openRequestsCountQ,
    clicksQ,
  ]);

  const fanEdits = (fanEditsRes.data ?? []) as Array<{
    id: string;
    platform: string;
    embed_url: string;
    caption: string | null;
    view_count: number | null;
    creator_id: string | null;
    creator_handle_displayed: string | null;
    thumbnail_url: string | null;
  }>;
  const fanEditIds = fanEdits.map((fe) => fe.id);
  const clicks = (clicksRes.data ?? []) as Array<{
    country_code: string | null;
    region_code: string | null;
    city: string | null;
    clicked_at: string;
  }>;

  const events: Array<{
    fan_edit_id: string;
    event_type: string;
    user_id: string | null;
    created_at: string;
    country_code: string | null;
    region_code: string | null;
    city: string | null;
  }> = await (async () => {
    if (fanEditIds.length === 0) return [];
    let q = supabase
      .from("fan_edit_events")
      .select(
        "fan_edit_id, event_type, user_id, created_at, country_code, region_code, city",
      )
      .in("fan_edit_id", fanEditIds);
    if (cutoff) q = q.gte("created_at", cutoff);
    const r = await q;
    return (r.data ?? []) as Array<{
      fan_edit_id: string;
      event_type: string;
      user_id: string | null;
      created_at: string;
      country_code: string | null;
      region_code: string | null;
      city: string | null;
    }>;
  })();

  const totalSocialViews = fanEdits.reduce(
    (s, fe) => s + (fe.view_count ?? 0),
    0,
  );
  const uniqueSignedInUsers = new Set(
    events
      .map((e) => e.user_id)
      .filter((id): id is string => Boolean(id)),
  ).size;

  const timeSeries = bucketTimeSeries(
    events.map((e) => e.created_at),
    win,
  );

  const stateData = countByState(
    clicks.map((c) => ({
      country_code: c.country_code,
      region_code: c.region_code,
    })),
  );
  const cityBreakdown = countByCity([
    ...clicks.map((c) => ({
      city: c.city,
      region_code: c.region_code,
      country_code: c.country_code,
    })),
    ...events.map((e) => ({
      city: e.city,
      region_code: e.region_code,
      country_code: e.country_code,
    })),
  ]);
  const totalGeoEvents = cityBreakdown.reduce((s, c) => s + c.count, 0);

  const modalOpensByFe = new Map<string, number>();
  const platformClicksByFe = new Map<string, number>();
  for (const e of events) {
    if (e.event_type === "modal_open") {
      modalOpensByFe.set(
        e.fan_edit_id,
        (modalOpensByFe.get(e.fan_edit_id) ?? 0) + 1,
      );
    } else if (e.event_type === "view_on_platform_click") {
      platformClicksByFe.set(
        e.fan_edit_id,
        (platformClicksByFe.get(e.fan_edit_id) ?? 0) + 1,
      );
    }
  }

  const creatorIds = Array.from(
    new Set(
      fanEdits
        .map((fe) => fe.creator_id)
        .filter((id): id is string => Boolean(id)),
    ),
  );
  const handleByCreatorId = new Map<string, string>();
  if (creatorIds.length > 0) {
    const { data: creators } = await supabase
      .from("public_creators")
      .select("id, moonbeem_handle")
      .in("id", creatorIds);
    for (const c of creators ?? []) {
      handleByCreatorId.set(c.id as string, c.moonbeem_handle as string);
    }
  }

  const fanEditsComparison = fanEdits.map((fe) => ({
    id: fe.id,
    platform: fe.platform,
    caption: fe.caption,
    thumbnail_url: fe.thumbnail_url,
    view_count: fe.view_count ?? 0,
    modal_opens: modalOpensByFe.get(fe.id) ?? 0,
    platform_clicks: platformClicksByFe.get(fe.id) ?? 0,
    creator_handle:
      (fe.creator_id && handleByCreatorId.get(fe.creator_id)) ||
      fe.creator_handle_displayed ||
      "anon",
  }));

  // Plain-object form for stateData so it serializes across the
  // server/client boundary (Map is not JSON-friendly).
  const stateDataRecord: Record<string, number> = {};
  for (const [k, v] of stateData) stateDataRecord[k] = v;

  return {
    events: events.length,
    uniqueSignedInUsers,
    clicks: clicks.length,
    totalSocialViews,
    fanEditsCount: fanEdits.length,
    openRequests: openRequestsRes.count ?? 0,
    timeSeries,
    stateData: stateDataRecord,
    cityBreakdown,
    totalGeoEvents,
    fanEditsComparison,
  };
}
