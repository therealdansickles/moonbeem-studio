// Partner dashboard at /p/[slug]/dashboard. Moved here from
// /p/[slug] on 2026-05-12 when the public catalog took over the
// shorter URL (Emerson Collective pitch — visitors expect a catalog
// view from a homepage partner marquee click, not gated analytics).
// Auth/membership semantics unchanged: anon and signed-in
// non-members get notFound(); partner-team members or super-admins
// see the full dashboard.
//
// All reads via service-role client on the server. RLS on the
// underlying tables (fan_edits, fan_edit_events, external_clicks,
// view_tracking_snapshots) doesn't have public SELECT policies, so
// service role is required.

import Link from "next/link";
import Image from "next/image";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getCurrentProfile, getUser } from "@/lib/dal";
import { createServiceRoleClient } from "@/lib/supabase/service";
import GrowthChart from "@/components/p/GrowthChart";
import AllEditsTable from "@/components/p/AllEditsTable";
import PartnerRatesCard from "@/components/p/PartnerRatesCard";
import TopPerformersCardClient from "@/components/p/TopPerformersCardClient";
import InitialAvatar from "@/components/p/InitialAvatar";
import { rankTierClass } from "@/components/p/rankTier";
import { formatMetric } from "@/lib/format";
import { PUBLICLY_READABLE_FAN_EDIT_STATUSES } from "@/lib/fan-edits/status";
import HeroNumber from "@/components/dashboard/HeroNumber";
import TimeSeriesChart from "@/components/dashboard/TimeSeriesChart";
import UsStateChoropleth from "@/components/dashboard/UsStateChoropleth";
import DataTable, { type Column } from "@/components/dashboard/DataTable";
import {
  TIME_WINDOWS,
  parseWindow,
  windowCutoffIso,
  windowLabel,
  windowShortLabel,
  bucketTimeSeries,
  countByState,
  countByCity,
  type TimeWindow,
} from "@/lib/dashboard/queries";

type SocialPlatform = "tiktok" | "instagram" | "twitter" | "youtube";

type PageProps = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ window?: string | string[] }>;
};

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const supabase = createServiceRoleClient();
  const { data: partner } = await supabase
    .from("partners")
    .select("name")
    .eq("slug", slug)
    .maybeSingle();
  if (!partner) return { title: "Partner dashboard" };
  return {
    title: `${partner.name} · Moonbeem partner dashboard`,
    robots: { index: false, follow: false },
  };
}

type HeroMetrics = {
  total_views: number;
  unique_creators: number;
  modal_opens: number;
  ticket_clicks: number;
};

async function loadHeroMetrics(
  supabase: ReturnType<typeof createServiceRoleClient>,
  titleIds: string[],
): Promise<HeroMetrics> {
  if (titleIds.length === 0) {
    return {
      total_views: 0,
      unique_creators: 0,
      modal_opens: 0,
      ticket_clicks: 0,
    };
  }

  // deleted_at filter required — service-role bypasses the public
  // RLS policy that filters soft-deleted rows for anon/authenticated
  // callers. Without this, soft-deleted duplicate fan_edits inflate
  // total_views, unique_creators, and (transitively) modal_opens
  // since fanEditIds derived here feed fan_edit_events lookups.
  // Same fix applied to loadTopPerformers, loadTopCreators,
  // loadAllEdits below.
  const { data: fanEdits } = await supabase
    .from("fan_edits")
    .select("id, view_count, creator_id")
    .in("title_id", titleIds)
    .eq("is_active", true)
    // publicly readable edits only (see audit 2026-05-16)
    .in("verification_status", PUBLICLY_READABLE_FAN_EDIT_STATUSES)
    .is("deleted_at", null);

  const fanEditRows = fanEdits ?? [];
  const totalViews = fanEditRows.reduce(
    (sum, fe) => sum + ((fe.view_count as number | null) ?? 0),
    0,
  );
  const uniqueCreators = new Set(
    fanEditRows
      .map((fe) => fe.creator_id as string | null)
      .filter((id): id is string => !!id),
  ).size;
  const fanEditIds = fanEditRows.map((fe) => fe.id as string);

  const [modalOpensRes, ticketClicksRes] = await Promise.all([
    fanEditIds.length > 0
      ? supabase
        .from("fan_edit_events")
        .select("id", { count: "exact", head: true })
        .eq("event_type", "modal_open")
        .in("fan_edit_id", fanEditIds)
      : Promise.resolve({ count: 0 } as { count: number | null }),
    supabase
      .from("external_clicks")
      .select("id", { count: "exact", head: true })
      .in("title_id", titleIds)
      .eq("is_bot", false)
      .not("title_offer_id", "is", null),
  ]);

  return {
    total_views: totalViews,
    unique_creators: uniqueCreators,
    modal_opens: modalOpensRes.count ?? 0,
    ticket_clicks: ticketClicksRes.count ?? 0,
  };
}

// Returns a Map<fan_edit_id, view_count_24h_ago> from the most recent
// snapshot older than 24h per fan_edit. Used to compute 24-hour
// growth deltas. Rows with no eligible snapshot get no entry — the
// caller renders "—" for those.
async function load24hGrowth(
  supabase: ReturnType<typeof createServiceRoleClient>,
  fanEditIds: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (fanEditIds.length === 0) return out;
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: snaps } = await supabase
    .from("view_tracking_snapshots")
    .select("fan_edit_id, view_count, captured_at")
    .in("fan_edit_id", fanEditIds)
    .lt("captured_at", cutoff)
    .order("captured_at", { ascending: false });
  for (const s of snaps ?? []) {
    const fid = s.fan_edit_id as string;
    if (!out.has(fid)) {
      out.set(fid, (s.view_count as number | null) ?? 0);
    }
  }
  return out;
}

// Resolves creator_id → moonbeem_handle via public_creators (the
// RLS-readable view of creators).
async function loadCreatorHandles(
  supabase: ReturnType<typeof createServiceRoleClient>,
  creatorIds: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (creatorIds.length === 0) return out;
  const { data: rows } = await supabase
    .from("public_creators")
    .select("id, moonbeem_handle")
    .in("id", creatorIds);
  for (const r of rows ?? []) {
    out.set(r.id as string, r.moonbeem_handle as string);
  }
  return out;
}

type TopPerformer = {
  id: string;
  platform: SocialPlatform;
  view_count: number;
  thumbnail_url: string | null;
  creator_id: string | null;
  // creator_handle = canonical moonbeem_handle (joined via
  // public_creators). Mapped to creator_moonbeem_handle when the
  // row is fed into the fan-edit modal.
  creator_handle: string | null;
  // Extra modal-compat fields. embed_url is the platform post URL
  // the modal embeds; creator_handle_displayed is the per-fan_edit
  // platform-side handle preserved verbatim from import. Both come
  // straight off the fan_edits row.
  embed_url: string;
  creator_handle_displayed: string | null;
  growth_24h: number | null;
  growth_pct_24h: number | null;
};

async function loadTopPerformers(
  supabase: ReturnType<typeof createServiceRoleClient>,
  titleIds: string[],
  limit = 10,
): Promise<TopPerformer[]> {
  if (titleIds.length === 0) return [];
  const { data: rows } = await supabase
    .from("fan_edits")
    .select(
      "id, platform, view_count, thumbnail_url, creator_id, embed_url, creator_handle_displayed",
    )
    .in("title_id", titleIds)
    .eq("is_active", true)
    // publicly readable edits only (see audit 2026-05-16)
    .in("verification_status", PUBLICLY_READABLE_FAN_EDIT_STATUSES)
    .is("deleted_at", null)
    .order("view_count", { ascending: false })
    .limit(limit);
  const fanEdits = rows ?? [];
  const ids = fanEdits.map((r) => r.id as string);
  const creatorIds = fanEdits
    .map((r) => r.creator_id as string | null)
    .filter((id): id is string => !!id);

  const [growth, handles] = await Promise.all([
    load24hGrowth(supabase, ids),
    loadCreatorHandles(supabase, creatorIds),
  ]);

  return fanEdits.map((r) => {
    const id = r.id as string;
    const current = (r.view_count as number | null) ?? 0;
    const prior = growth.get(id);
    const delta = prior !== undefined ? current - prior : null;
    const pct = prior !== undefined && prior > 0
      ? (delta! / prior) * 100
      : null;
    return {
      id,
      platform: r.platform as SocialPlatform,
      view_count: current,
      thumbnail_url: r.thumbnail_url as string | null,
      creator_id: r.creator_id as string | null,
      creator_handle: r.creator_id
        ? handles.get(r.creator_id as string) ?? null
        : null,
      embed_url: r.embed_url as string,
      creator_handle_displayed: r.creator_handle_displayed as string | null,
      growth_24h: delta,
      growth_pct_24h: pct,
    };
  });
}

type TopCreator = {
  creator_id: string;
  handle: string;
  total_views: number;
  edit_count: number;
};

async function loadTopCreators(
  supabase: ReturnType<typeof createServiceRoleClient>,
  titleIds: string[],
  limit = 10,
): Promise<TopCreator[]> {
  if (titleIds.length === 0) return [];
  const { data: edits } = await supabase
    .from("fan_edits")
    .select("creator_id, view_count")
    .in("title_id", titleIds)
    .eq("is_active", true)
    // publicly readable edits only (see audit 2026-05-16)
    .in("verification_status", PUBLICLY_READABLE_FAN_EDIT_STATUSES)
    .is("deleted_at", null)
    .not("creator_id", "is", null);

  const aggs = new Map<string, { views: number; edits: number }>();
  for (const e of edits ?? []) {
    const cid = e.creator_id as string;
    const a = aggs.get(cid) ?? { views: 0, edits: 0 };
    a.views += (e.view_count as number | null) ?? 0;
    a.edits += 1;
    aggs.set(cid, a);
  }
  const top = [...aggs.entries()]
    .sort(([, a], [, b]) => b.views - a.views)
    .slice(0, limit);

  const handles = await loadCreatorHandles(
    supabase,
    top.map(([id]) => id),
  );
  return top.map(([cid, agg]) => ({
    creator_id: cid,
    handle: handles.get(cid) ?? "anon",
    total_views: agg.views,
    edit_count: agg.edits,
  }));
}

// InitialAvatar + rank-tier helper moved to /components/p/ for reuse
// across TopPerformersCardClient + TopCreatorsCard.

// GrowthBadge moved to @/components/p/GrowthBadge for reuse by the
// client-side TopPerformersCardClient.

function TopPerformersCard({
  performers,
  titleSlug,
  titleName,
}: {
  performers: TopPerformer[];
  titleSlug: string;
  titleName: string;
}) {
  // Pre-build the modal-compat list once; passing { fanEdits, index }
  // on every row click is cheaper than rebuilding inside the handler.
  const modalList = performers.map((p) => ({
    id: p.id,
    platform: p.platform,
    embed_url: p.embed_url,
    creator_handle_displayed: p.creator_handle_displayed,
    creator_moonbeem_handle: p.creator_handle,
  }));
  return (
    <TopPerformersCardClient
      performers={performers}
      modalList={modalList}
      titleSlug={titleSlug}
      titleName={titleName}
    />
  );
}

// COUNT(modal_open) per fan_edit. The dashboard's ALL-edits table
// surfaces this; the hero tile uses a single COUNT separately.
async function loadModalOpensMap(
  supabase: ReturnType<typeof createServiceRoleClient>,
  fanEditIds: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (fanEditIds.length === 0) return out;
  const { data: events } = await supabase
    .from("fan_edit_events")
    .select("fan_edit_id")
    .eq("event_type", "modal_open")
    .in("fan_edit_id", fanEditIds);
  for (const e of events ?? []) {
    const fid = e.fan_edit_id as string;
    out.set(fid, (out.get(fid) ?? 0) + 1);
  }
  return out;
}

// Earliest captured_at across the partner's fan_edits, returned as
// a YYYY-MM-DD string. Used to annotate the growth chart so partners
// understand why the chart is short — view-tracking history starts
// at this date, not at fan_edit creation. Returns null when there
// are no snapshots yet.
async function loadTrackingStartDay(
  supabase: ReturnType<typeof createServiceRoleClient>,
  fanEditIds: string[],
): Promise<string | null> {
  if (fanEditIds.length === 0) return null;
  const { data } = await supabase
    .from("view_tracking_snapshots")
    .select("captured_at")
    .in("fan_edit_id", fanEditIds)
    .order("captured_at", { ascending: true })
    .limit(1);
  const first = data?.[0];
  if (!first) return null;
  return (first.captured_at as string).slice(0, 10);
}

// Daily-summed total views + cumulative-as-of-day fan_edit count
// across the partner's titles. Returned series anchors to the
// earliest view_tracking_snapshot date for the partner's edits
// (per Dan's 2026-05-10 spec — "when the data actually starts being
// meaningful"). No lookback cutoff; the GrowthChart client component
// owns period filtering (1D/1W/1M/All).
//
// Views: per (fan_edit_id, day) keep max view_count, forward-fill
// across days so the daily sum doesn't dip on days where only some
// edits got refreshed.
//
// edit_count: cumulative count of fan_edits where created_at <= day
// AND deleted_at IS NULL. Provides context for sparse view-tracking
// history — when there are only 5 days of view data but 20 edits
// were added over 14 days, the edit-count line shows catalog growth
// the view-count line can't.
async function loadDailyGrowth(
  supabase: ReturnType<typeof createServiceRoleClient>,
  fanEditIds: string[],
  titleIds: string[],
): Promise<
  Array<{
    day: string;
    views: number;
    edit_count: number;
    views_delta: number | null;
    edit_count_delta: number | null;
  }>
> {
  if (fanEditIds.length === 0 || titleIds.length === 0) return [];

  const [{ data: snaps }, { data: edits }] = await Promise.all([
    supabase
      .from("view_tracking_snapshots")
      .select("fan_edit_id, view_count, captured_at")
      .in("fan_edit_id", fanEditIds)
      .order("captured_at", { ascending: true }),
    supabase
      .from("fan_edits")
      .select("created_at")
      .in("title_id", titleIds)
      .eq("is_active", true)
      // publicly readable edits only (see audit 2026-05-16)
      .in("verification_status", PUBLICLY_READABLE_FAN_EDIT_STATUSES)
      .is("deleted_at", null),
  ]);

  const perEditPerDay = new Map<string, Map<string, number>>();
  const allDays = new Set<string>();
  for (const s of snaps ?? []) {
    const fid = s.fan_edit_id as string;
    const day = (s.captured_at as string).slice(0, 10);
    const v = (s.view_count as number | null) ?? 0;
    allDays.add(day);
    let editMap = perEditPerDay.get(fid);
    if (!editMap) {
      editMap = new Map();
      perEditPerDay.set(fid, editMap);
    }
    const existing = editMap.get(day) ?? 0;
    if (v > existing) editMap.set(day, v);
  }

  if (allDays.size === 0) return [];

  // Walk every day from earliest snapshot to today so the edit_count
  // line keeps progressing even on days where no snapshot ran.
  const startDay = [...allDays].sort()[0];
  const days: string[] = [];
  const today = new Date().toISOString().slice(0, 10);
  for (
    let d = new Date(startDay + "T00:00:00Z");
    d.toISOString().slice(0, 10) <= today;
    d.setUTCDate(d.getUTCDate() + 1)
  ) {
    days.push(d.toISOString().slice(0, 10));
  }

  // Pre-sort fan_edit created days for a one-pass cumulative count.
  const editCreatedDays = (edits ?? [])
    .map((e) => (e.created_at as string).slice(0, 10))
    .sort();

  const editLatest = new Map<string, number>();
  let editCursor = 0;
  let prevViews = 0;
  let prevEditCount = 0;
  return days.map((d, i) => {
    for (const [fid, dayMap] of perEditPerDay) {
      if (dayMap.has(d)) editLatest.set(fid, dayMap.get(d)!);
    }
    let totalViews = 0;
    for (const v of editLatest.values()) totalViews += v;
    while (
      editCursor < editCreatedDays.length &&
      editCreatedDays[editCursor] <= d
    ) {
      editCursor += 1;
    }
    // First-day deltas are null (no "previous day" reference) so the
    // tooltip renders an em-dash instead of misleading +N values.
    const views_delta = i === 0 ? null : totalViews - prevViews;
    const edit_count_delta = i === 0 ? null : editCursor - prevEditCount;
    prevViews = totalViews;
    prevEditCount = editCursor;
    return {
      day: d,
      views: totalViews,
      edit_count: editCursor,
      views_delta,
      edit_count_delta,
    };
  });
}

type AllEditRow = {
  id: string;
  platform: SocialPlatform;
  thumbnail_url: string | null;
  creator_handle: string | null;
  // Modal-compat fields, same rationale as TopPerformer.
  embed_url: string;
  creator_handle_displayed: string | null;
  view_count: number;
  growth_24h: number | null;
  modal_opens: number;
};

async function loadAllEdits(
  supabase: ReturnType<typeof createServiceRoleClient>,
  titleIds: string[],
): Promise<AllEditRow[]> {
  if (titleIds.length === 0) return [];
  const { data: rows } = await supabase
    .from("fan_edits")
    .select(
      "id, platform, view_count, thumbnail_url, creator_id, embed_url, creator_handle_displayed",
    )
    .in("title_id", titleIds)
    .eq("is_active", true)
    // publicly readable edits only (see audit 2026-05-16)
    .in("verification_status", PUBLICLY_READABLE_FAN_EDIT_STATUSES)
    .is("deleted_at", null)
    .order("view_count", { ascending: false });

  const fanEdits = rows ?? [];
  const ids = fanEdits.map((r) => r.id as string);
  const creatorIds = fanEdits
    .map((r) => r.creator_id as string | null)
    .filter((id): id is string => !!id);

  const [growth, handles, modalOpens] = await Promise.all([
    load24hGrowth(supabase, ids),
    loadCreatorHandles(supabase, creatorIds),
    loadModalOpensMap(supabase, ids),
  ]);

  return fanEdits.map((r) => {
    const id = r.id as string;
    const current = (r.view_count as number | null) ?? 0;
    const prior = growth.get(id);
    const delta = prior !== undefined ? current - prior : null;
    return {
      id,
      platform: r.platform as SocialPlatform,
      thumbnail_url: r.thumbnail_url as string | null,
      creator_handle: r.creator_id
        ? handles.get(r.creator_id as string) ?? null
        : null,
      embed_url: r.embed_url as string,
      creator_handle_displayed: r.creator_handle_displayed as string | null,
      view_count: current,
      growth_24h: delta,
      modal_opens: modalOpens.get(id) ?? 0,
    };
  });
}

function TopCreatorsCard({ creators }: { creators: TopCreator[] }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
      <div className="flex items-center gap-3">
        <span className="rounded-full bg-moonbeem-pink/15 px-2.5 py-0.5 text-caption font-medium text-moonbeem-pink">
          Top editors
        </span>
        <span className="text-caption text-moonbeem-ink-subtle">
          by total views
        </span>
      </div>
      <ol className="mt-4 flex flex-col">
        {creators.map((c, i) => {
          const rank = i + 1;
          return (
            <li key={c.creator_id}>
              {/* Whole-row link: hover bg shift + cursor-pointer make
                  the row's clickability obvious. */}
              <Link
                href={`/c/${c.handle}`}
                className="-mx-2 flex items-center gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-white/[0.035]"
              >
                <span
                  className={`w-5 shrink-0 text-caption font-semibold tabular-nums ${rankTierClass(rank)}`}
                >
                  {rank}
                </span>
                <InitialAvatar handle={c.handle} />
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-body-sm font-medium text-moonbeem-ink">
                    @{c.handle}
                  </span>
                  <span className="text-caption text-moonbeem-ink-subtle">
                    {c.edit_count} {c.edit_count === 1 ? "edit" : "edits"}
                  </span>
                </div>
                <span className="text-body-sm font-semibold tabular-nums text-moonbeem-ink">
                  {formatMetric(c.total_views)}
                </span>
              </Link>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

// Open title requests for this partner — visitors hit "Request fan
// edits" on /t/[slug], which inserts a row into title_requests.
// title_requests has no fulfilled_at column today (followup queue
// has a schema-level fix). We derive fulfillment at the display
// layer here: a title is "open" if it has NO published fan_edits
// (is_active + auto_verified + not soft-deleted). Once a partner
// ships fan_edits for a requested title, the title falls out of
// this card naturally.
type RequestedTitle = {
  title_id: string;
  slug: string;
  title: string;
  poster_url: string | null;
  request_count: number;
  latest_request_at: string;
};

async function loadOpenTitleRequests(
  supabase: ReturnType<typeof createServiceRoleClient>,
  partnerTitleIds: string[],
): Promise<RequestedTitle[]> {
  if (partnerTitleIds.length === 0) return [];
  // Open = fulfilled_at IS NULL. Fulfillment is set by the fan-edit
  // insert hook (and the /api/titles/request handler when the title is
  // already covered) — no need to re-derive via fan_edits join here.
  const { data: requests } = await supabase
    .from("title_requests")
    .select("title_id, requested_at, request_type")
    .in("title_id", partnerTitleIds)
    .eq("request_type", "fan_edits")
    .is("fulfilled_at", null);
  if (!requests || requests.length === 0) return [];

  // 3. Group + latest-timestamp per title.
  const counts = new Map<string, number>();
  const latest = new Map<string, string>();
  for (const r of requests) {
    const tid = r.title_id as string;
    counts.set(tid, (counts.get(tid) ?? 0) + 1);
    const at = r.requested_at as string;
    const prev = latest.get(tid);
    if (!prev || at > prev) latest.set(tid, at);
  }

  // 4. Hydrate title display fields.
  const requestedIds = Array.from(counts.keys());
  const { data: titles } = await supabase
    .from("titles")
    .select("id, slug, title, poster_url")
    .in("id", requestedIds);

  const out: RequestedTitle[] = [];
  for (const t of titles ?? []) {
    out.push({
      title_id: t.id as string,
      slug: t.slug as string,
      title: t.title as string,
      poster_url: (t.poster_url as string | null) ?? null,
      request_count: counts.get(t.id as string) ?? 0,
      latest_request_at: latest.get(t.id as string) ?? "",
    });
  }
  // Count DESC, then title name ASC for tiebreaker. Defensive cap at
  // 20 — today the dataset is tiny; cap protects future scale.
  out.sort((a, b) => {
    if (b.request_count !== a.request_count) {
      return b.request_count - a.request_count;
    }
    return a.title.localeCompare(b.title);
  });
  return out.slice(0, 20);
}

function RequestedTitlesCard({
  requestedTitles,
}: {
  requestedTitles: RequestedTitle[];
}) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
      <div className="flex items-center gap-3">
        <span className="rounded-full bg-moonbeem-pink/15 px-2.5 py-0.5 text-caption font-medium text-moonbeem-pink">
          Requested titles
        </span>
        <span className="text-caption text-moonbeem-ink-subtle">
          edits not yet published
        </span>
      </div>
      {requestedTitles.length === 0 ? (
        <p className="mt-4 text-body-sm text-moonbeem-ink-muted">
          No edit requests for your titles yet.
        </p>
      ) : (
        <ol className="mt-4 flex flex-col">
          {requestedTitles.map((t) => (
            <li key={t.title_id}>
              <Link
                href={`/t/${t.slug}`}
                className="-mx-2 flex items-center gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-white/[0.035]"
              >
                {t.poster_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={t.poster_url}
                    alt=""
                    className="h-12 w-8 shrink-0 rounded object-cover"
                    draggable={false}
                  />
                ) : (
                  <div className="h-12 w-8 shrink-0 rounded bg-moonbeem-navy/40" />
                )}
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-body-sm font-medium text-moonbeem-ink">
                    {t.title}
                  </span>
                  <span className="text-caption text-moonbeem-ink-subtle">
                    latest {new Date(t.latest_request_at).toLocaleDateString()}
                  </span>
                </div>
                <span className="shrink-0 text-body-sm font-semibold tabular-nums text-moonbeem-ink">
                  {t.request_count}{" "}
                  <span className="text-caption text-moonbeem-ink-subtle">
                    {t.request_count === 1 ? "request" : "requests"}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function HeroTile({
  value,
  label,
  sub,
}: {
  value: string;
  label: string;
  sub?: string;
}) {
  return (
    <div
      className="rounded-2xl border border-white/10 p-4 md:p-5"
      // Diagonal deep-purple → soft-pink gradient at ~70-85% over a
      // near-black base so the saturation reads premium without
      // overwhelming the white number text on top. Subtle inner-top
      // highlight (1px) gives a slight 3D lift without competing
      // with the gradient. No hover state — partner dashboards are
      // presentation surfaces, not interactive tools.
      style={{
        background:
          "linear-gradient(135deg, rgba(46,16,101,0.85) 0%, rgba(219,39,119,0.7) 100%), #0a0014",
        boxShadow: "inset 0 1px 0 rgba(255,255,255,0.08)",
      }}
    >
      <div className="font-wordmark text-display-sm md:text-display-md text-white leading-none tabular-nums">
        {value}
      </div>
      <div className="mt-2 text-body font-medium text-moonbeem-ink">
        {label}
      </div>
      {sub && (
        <div className="mt-1 text-caption text-moonbeem-ink-subtle">{sub}</div>
      )}
    </div>
  );
}

type TitleRollupRow = {
  id: string;
  slug: string;
  title: string;
  poster_url: string | null;
  fan_edit_count: number;
  total_social_views: number;
  modal_opens: number;
  platform_clicks: number;
  go_clicks: number;
  open_requests: number;
};

function PerTitleRollup({
  titles,
  perTitle,
  isSuperAdmin,
}: {
  titles: Array<{
    id: string;
    slug: string;
    title: string;
    poster_url: string | null;
  }>;
  perTitle: Array<{
    title_id: string;
    fan_edit_count: number;
    total_social_views: number;
    modal_opens: number;
    platform_clicks: number;
    go_clicks: number;
    open_requests: number;
  }>;
  isSuperAdmin: boolean;
}) {
  const metricsByTitle = new Map(perTitle.map((p) => [p.title_id, p]));
  const rows: TitleRollupRow[] = titles
    .map((t) => {
      const m = metricsByTitle.get(t.id);
      return {
        id: t.id,
        slug: t.slug,
        title: t.title,
        poster_url: t.poster_url,
        fan_edit_count: m?.fan_edit_count ?? 0,
        total_social_views: m?.total_social_views ?? 0,
        modal_opens: m?.modal_opens ?? 0,
        platform_clicks: m?.platform_clicks ?? 0,
        go_clicks: m?.go_clicks ?? 0,
        open_requests: m?.open_requests ?? 0,
      };
    })
    .sort((a, b) => b.total_social_views - a.total_social_views);

  const columns: Column<TitleRollupRow>[] = [
    {
      key: "poster",
      label: "",
      render: (r) =>
        r.poster_url ? (
          <div className="h-[60px] w-[40px] shrink-0 overflow-hidden rounded-sm bg-white/[0.03]">
            <Image
              src={r.poster_url}
              alt=""
              width={40}
              height={60}
              className="h-full w-full object-cover"
              unoptimized
            />
          </div>
        ) : (
          <div className="h-[60px] w-[40px] shrink-0 rounded-sm border border-white/10 bg-white/[0.03]" />
        ),
    },
    {
      key: "title",
      label: "Title",
      render: (r) =>
        isSuperAdmin ? (
          <Link
            href={`/admin/titles/${r.slug}?tab=analytics`}
            className="text-moonbeem-pink hover:opacity-90 text-body-sm"
          >
            {r.title}
          </Link>
        ) : (
          <Link
            href={`/t/${r.slug}`}
            className="text-moonbeem-ink hover:text-moonbeem-pink text-body-sm"
          >
            {r.title}
          </Link>
        ),
    },
    {
      key: "edits",
      label: "Edits",
      align: "right",
      render: (r) => r.fan_edit_count.toLocaleString(),
    },
    {
      key: "views",
      label: "Views",
      align: "right",
      render: (r) => r.total_social_views.toLocaleString(),
    },
    {
      key: "opens",
      label: "Modal opens",
      align: "right",
      render: (r) => r.modal_opens.toLocaleString(),
    },
    {
      key: "go",
      label: "/go/ clicks",
      align: "right",
      render: (r) => r.go_clicks.toLocaleString(),
    },
    {
      key: "requests",
      label: "Open requests",
      align: "right",
      render: (r) => r.open_requests.toLocaleString(),
    },
  ];

  return (
    <DataTable<TitleRollupRow>
      columns={columns}
      rows={rows}
      rowKey={(r) => r.id}
      emptyMessage="No active titles."
    />
  );
}

type PartnerAnalytics = {
  events: number;
  uniqueSignedInUsers: number;
  goClicks: number;
  openRequests: number;
  activeTitlesCount: number;
  totalSocialViews: number;
  timeSeries: { date: string; value: number }[];
  stateData: Map<string, number>;
  cityBreakdown: ReturnType<typeof countByCity>;
  totalGeoEvents: number;
  perTitle: Array<{
    title_id: string;
    fan_edit_count: number;
    total_social_views: number;
    modal_opens: number;
    platform_clicks: number;
    go_clicks: number;
    open_requests: number;
  }>;
};

async function loadPartnerAnalytics(
  supabase: ReturnType<typeof createServiceRoleClient>,
  activeTitleIds: string[],
  win: TimeWindow,
  cutoff: string | null,
): Promise<PartnerAnalytics> {
  const empty: PartnerAnalytics = {
    events: 0,
    uniqueSignedInUsers: 0,
    goClicks: 0,
    openRequests: 0,
    activeTitlesCount: 0,
    totalSocialViews: 0,
    timeSeries: bucketTimeSeries([], win),
    stateData: new Map(),
    cityBreakdown: [],
    totalGeoEvents: 0,
    perTitle: [],
  };
  if (activeTitleIds.length === 0) return empty;

  // Active fan_edits for the partner's titles — drives the per-title
  // rollup (fan_edit_count, view sum) and bounds the event lookup.
  const fanEditsQ = supabase
    .from("fan_edits")
    .select("id, title_id, view_count")
    .in("title_id", activeTitleIds)
    .eq("is_active", true)
    // publicly readable edits only (see audit 2026-05-16)
    .in("verification_status", PUBLICLY_READABLE_FAN_EDIT_STATUSES)
    .is("deleted_at", null);

  const clicksQ = (() => {
    let q = supabase
      .from("external_clicks")
      .select("title_id, country_code, region_code, city, clicked_at")
      .in("title_id", activeTitleIds)
      .eq("is_bot", false);
    if (cutoff) q = q.gte("clicked_at", cutoff);
    return q;
  })();

  const openRequestsQ = supabase
    .from("title_requests")
    .select("title_id")
    .in("title_id", activeTitleIds)
    .is("fulfilled_at", null)
    .eq("request_type", "fan_edits");

  const [fanEditsRes, clicksRes, openRequestsRes] = await Promise.all([
    fanEditsQ,
    clicksQ,
    openRequestsQ,
  ]);

  const fanEdits = (fanEditsRes.data ?? []) as Array<{
    id: string;
    title_id: string;
    view_count: number | null;
  }>;
  const clicks = (clicksRes.data ?? []) as Array<{
    title_id: string;
    country_code: string | null;
    region_code: string | null;
    city: string | null;
    clicked_at: string;
  }>;
  const openRequests = (openRequestsRes.data ?? []) as { title_id: string }[];

  const fanEditIds = fanEdits.map((fe) => fe.id);
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
    events.map((e) => e.user_id).filter((id): id is string => Boolean(id)),
  ).size;

  const timeSeries = bucketTimeSeries(
    events.map((e) => e.created_at),
    win,
  );
  // Choropleth + city table share the same combined-source feed.
  // countByState filters to country_code === "US" so non-US geo
  // drops out of the map without an explicit filter here.
  const combinedGeoRows = [
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
  ];
  const stateData = countByState(combinedGeoRows);
  const cityBreakdown = countByCity(combinedGeoRows);
  const totalGeoEvents = cityBreakdown.reduce((s, c) => s + c.count, 0);

  // Per-title rollups
  const fanEditIdsByTitle = new Map<string, string[]>();
  const fanEditCountByTitle = new Map<string, number>();
  const socialViewsByTitle = new Map<string, number>();
  for (const fe of fanEdits) {
    const arr = fanEditIdsByTitle.get(fe.title_id) ?? [];
    arr.push(fe.id);
    fanEditIdsByTitle.set(fe.title_id, arr);
    fanEditCountByTitle.set(
      fe.title_id,
      (fanEditCountByTitle.get(fe.title_id) ?? 0) + 1,
    );
    socialViewsByTitle.set(
      fe.title_id,
      (socialViewsByTitle.get(fe.title_id) ?? 0) + (fe.view_count ?? 0),
    );
  }
  const titleByFanEdit = new Map<string, string>();
  for (const [tid, ids] of fanEditIdsByTitle) {
    for (const fid of ids) titleByFanEdit.set(fid, tid);
  }
  const modalOpensByTitle = new Map<string, number>();
  const platformClicksByTitle = new Map<string, number>();
  for (const e of events) {
    const tid = titleByFanEdit.get(e.fan_edit_id);
    if (!tid) continue;
    if (e.event_type === "modal_open") {
      modalOpensByTitle.set(tid, (modalOpensByTitle.get(tid) ?? 0) + 1);
    } else if (e.event_type === "view_on_platform_click") {
      platformClicksByTitle.set(
        tid,
        (platformClicksByTitle.get(tid) ?? 0) + 1,
      );
    }
  }
  const goClicksByTitle = new Map<string, number>();
  for (const c of clicks) {
    goClicksByTitle.set(c.title_id, (goClicksByTitle.get(c.title_id) ?? 0) + 1);
  }
  const openRequestsByTitle = new Map<string, number>();
  for (const r of openRequests) {
    openRequestsByTitle.set(
      r.title_id,
      (openRequestsByTitle.get(r.title_id) ?? 0) + 1,
    );
  }

  const perTitle = activeTitleIds.map((tid) => ({
    title_id: tid,
    fan_edit_count: fanEditCountByTitle.get(tid) ?? 0,
    total_social_views: socialViewsByTitle.get(tid) ?? 0,
    modal_opens: modalOpensByTitle.get(tid) ?? 0,
    platform_clicks: platformClicksByTitle.get(tid) ?? 0,
    go_clicks: goClicksByTitle.get(tid) ?? 0,
    open_requests: openRequestsByTitle.get(tid) ?? 0,
  }));

  return {
    events: events.length,
    uniqueSignedInUsers,
    goClicks: clicks.length,
    openRequests: openRequests.length,
    activeTitlesCount: activeTitleIds.length,
    totalSocialViews,
    timeSeries,
    stateData,
    cityBreakdown,
    totalGeoEvents,
    perTitle,
  };
}

export default async function PartnerDashboardPage({
  params,
  searchParams,
}: PageProps) {
  const { slug } = await params;
  const sp = await searchParams;
  const win = parseWindow(sp.window);
  const cutoff = windowCutoffIso(win);

  // Auth + membership check at the page level. We deliberately do NOT
  // redirect to /login on missing auth — the dashboard URL is a real
  // signal we don't want to leak ("404 hides existence"). Anonymous
  // visitors and signed-in non-members both get notFound().
  const user = await getUser();
  if (!user) notFound();

  const supabase = createServiceRoleClient();

  const { data: partner, error: partnerErr } = await supabase
    .from("partners")
    .select("id, slug, name, logo_url")
    .eq("slug", slug)
    .maybeSingle();
  if (partnerErr || !partner) notFound();

  // Access: partner_users membership OR super_admin role. Super
  // admins (Moonbeem ops) need every partner dashboard for
  // debugging, demo prep, and verifying campaigns — adding them to
  // partner_users for every partner is duplicative and error-prone.
  // Partner-team members still scope only to their own partner.
  // Super admins are also treated as partner-admin so they can edit
  // CPM rates etc. without a separate code path.
  const profile = await getCurrentProfile();
  const isSuperAdmin = profile?.role === "super_admin";
  let membershipRole: string | null = null;
  if (!isSuperAdmin) {
    const { data: membership } = await supabase
      .from("partner_users")
      .select("role")
      .eq("partner_id", partner.id)
      .eq("user_id", user.id)
      .is("deleted_at", null)
      .maybeSingle();
    if (!membership) notFound();
    membershipRole = (membership.role as string) ?? null;
  }
  const isPartnerAdmin = isSuperAdmin || membershipRole === "admin";

  const { data: titles } = await supabase
    .from("titles")
    .select("id, slug, title, poster_url, is_active")
    .eq("partner_id", partner.id)
    .is("deleted_at", null);
  const titleRows = (titles ?? []) as Array<{
    id: string;
    slug: string;
    title: string;
    poster_url: string | null;
    is_active: boolean;
  }>;
  const titleIds = titleRows.map((t) => t.id);
  const activeTitleIds = titleRows.filter((t) => t.is_active).map((t) => t.id);

  const [metrics, topPerformers, topCreators, allEdits, requestedTitles] =
    await Promise.all([
      loadHeroMetrics(supabase, titleIds),
      // Asymmetric Top-N: edits=10 (content, curated/selective);
      // editors=12 (people, matches the Moonbeem "Top 12" brand
      // staple used profile-side). The split preserves the
      // two-column dashboard's vertical balance.
      loadTopPerformers(supabase, titleIds, 10),
      loadTopCreators(supabase, titleIds, 12),
      loadAllEdits(supabase, titleIds),
      loadOpenTitleRequests(supabase, titleIds),
    ]);
  const fanEditIdsForTracking = allEdits.map((r) => r.id);
  const [dailyGrowth, trackingStartDay] = await Promise.all([
    loadDailyGrowth(supabase, fanEditIdsForTracking, titleIds),
    loadTrackingStartDay(supabase, fanEditIdsForTracking),
  ]);

  // Window-scoped analytical layer — Visx time-series, US choropleth,
  // city table, and a per-title rollup. Folded in from the now-deleted
  // /admin/partners/[slug]/dashboard. Scope is the partner's active
  // titles only; soft-deleted titles drop out naturally above.
  const analytics = await loadPartnerAnalytics(
    supabase,
    activeTitleIds,
    win,
    cutoff,
  );

  // Per-title CPM rates + this-month earnings rollup for the
  // "Pay creators" card.
  const { data: rateRows } = await supabase
    .from("partner_title_rates")
    .select("title_id, rate_cents_per_thousand")
    .eq("partner_id", partner.id)
    .is("deleted_at", null);
  const rateByTitle = new Map<string, number>();
  for (const r of rateRows ?? []) {
    rateByTitle.set(r.title_id as string, r.rate_cents_per_thousand as number);
  }
  const titleRates = titleRows.map((t) => ({
    title_id: t.id as string,
    title: t.title as string,
    rate_cents_per_thousand: rateByTitle.get(t.id as string) ?? null,
  }));

  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const { data: monthEarnings } = await supabase
    .from("creator_earnings")
    .select("earnings_cents, creator_id")
    .eq("partner_id", partner.id)
    .gte("calculation_date", monthStart.toISOString().slice(0, 10));
  let paidThisMonthCents = 0;
  const creatorsThisMonth = new Set<string>();
  for (const e of monthEarnings ?? []) {
    paidThisMonthCents += (e.earnings_cents as number | null) ?? 0;
    if (e.creator_id) creatorsThisMonth.add(e.creator_id as string);
  }

  const titleSummary = titleRows.length === 1
    ? titleRows[0].title
    : `${titleRows.length} titles`;
  const primarySlug = (titleRows[0]?.slug as string | undefined) ?? "";
  const primaryName = (titleRows[0]?.title as string | undefined) ?? "";

  return (
    <div className="min-h-screen px-4 py-6 md:px-6 md:py-12 bg-[radial-gradient(ellipse_at_top,_#1a0f3a_0%,_#0a0a14_60%)]">
      <div className="mx-auto max-w-6xl">
        <div className="flex flex-col items-start gap-3 md:flex-row md:items-center md:justify-between">
          {isSuperAdmin && (
            <div className="flex flex-wrap items-center gap-3">
              <span className="rounded-full bg-moonbeem-pink/15 px-2.5 py-0.5 text-caption font-medium text-moonbeem-pink">
                Super admin view
              </span>
              <Link
                href="/admin/dashboard"
                className="text-caption text-moonbeem-ink-muted hover:text-moonbeem-pink"
              >
                Admin overview →
              </Link>
            </div>
          )}
          {partner.logo_url
            ? (
              <img
                src={partner.logo_url as string}
                alt={partner.name as string}
                className="h-8 w-auto opacity-80"
              />
            )
            : (
              <span className="text-body-sm text-moonbeem-ink-subtle">
                Partner dashboard
              </span>
            )}
        </div>

        <div className="mt-10 flex flex-col gap-2">
          <h1 className="font-wordmark text-display-md md:text-display-lg text-moonbeem-ink m-0">
            {partner.name}
          </h1>
          <p className="text-body text-moonbeem-ink-muted m-0">
            {titleSummary} · partnership dashboard
          </p>
        </div>

        <div className="mt-6 md:mt-10 grid grid-cols-2 gap-3 md:gap-4 lg:grid-cols-4">
          <HeroTile
            value={formatMetric(metrics.total_views)}
            label="Total platform views"
            sub={`lifetime views across ${titleRows.length === 1 ? "the title's" : "all"} fan edits`}
          />
          <HeroTile
            value={metrics.unique_creators.toLocaleString()}
            label="Unique fan creators"
          />
          <HeroTile
            value={formatMetric(metrics.modal_opens)}
            label="Moonbeem plays"
            sub="opens in Moonbeem's player"
          />
          <HeroTile
            value={metrics.ticket_clicks.toLocaleString()}
            label="Ticket click-throughs"
            sub="outbound to listings"
          />
        </div>

        {/* Window-scoped analytical section — Visx primitives layered
            on top of the existing presentation aesthetic. Controls the
            engagement tiles, time-series, geography, and per-title
            rollup below. Lifetime hero tiles above are not affected. */}
        <div className="mt-12 flex flex-wrap items-center gap-2">
          <span className="text-body-sm text-moonbeem-ink-muted mr-1">
            Window:
          </span>
          {TIME_WINDOWS.map((w) => {
            const active = w === win;
            return (
              <Link
                key={w}
                href={
                  w === "7d"
                    ? `/p/${partner.slug}/dashboard`
                    : `/p/${partner.slug}/dashboard?window=${w}`
                }
                scroll={false}
                className={`rounded-md border px-3 py-1.5 text-body-sm transition-colors tabular-nums ${
                  active
                    ? "border-moonbeem-pink bg-moonbeem-pink/10 text-moonbeem-pink"
                    : "border-white/10 text-moonbeem-ink-muted hover:border-moonbeem-pink hover:text-moonbeem-pink"
                }`}
              >
                {windowShortLabel(w)}
              </Link>
            );
          })}
          <span className="ml-2 text-caption text-moonbeem-ink-subtle">
            {windowLabel(win)}
          </span>
        </div>

        <section className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-4 md:gap-4">
          <HeroNumber
            value={analytics.events.toLocaleString()}
            label="Engagement events"
            responsive
          />
          <HeroNumber
            value={analytics.uniqueSignedInUsers.toLocaleString()}
            label="Signed-in users"
            responsive
          />
          <HeroNumber
            value={analytics.goClicks.toLocaleString()}
            label="/go/ clicks (humans)"
            responsive
          />
          <HeroNumber
            value={analytics.openRequests.toLocaleString()}
            label="Open title requests"
            responsive
          />
        </section>

        <section className="mt-10 flex flex-col gap-3">
          <h2 className="text-heading-lg md:text-display-sm m-0">Engagement over time</h2>
          <p className="text-body-sm text-moonbeem-ink-muted m-0">
            Fan-edit modal events across this partner&apos;s catalog ·{" "}
            {win === "24h" ? "hourly" : "daily"} buckets
          </p>
          <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
            {analytics.timeSeries.length === 0 ||
            analytics.events === 0 ? (
              <p className="text-body-sm text-moonbeem-ink-muted text-center py-12 m-0">
                No engagement events in this window.
              </p>
            ) : (
              <TimeSeriesChart data={analytics.timeSeries} yLabel="events" />
            )}
          </div>
        </section>

        <section className="mt-10 flex flex-col gap-3">
          <h2 className="text-heading-lg md:text-display-sm m-0">Geography</h2>
          <p className="text-body-sm text-moonbeem-ink-muted m-0">
            /go/ click + consent-gated event origins ·{" "}
            {analytics.totalGeoEvents.toLocaleString()} geo-tagged event
            {analytics.totalGeoEvents === 1 ? "" : "s"} in window
          </p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="md:col-span-2 rounded-2xl border border-white/10 bg-white/[0.02] p-4">
              <div className="h-[260px] md:h-[360px]">
                <UsStateChoropleth data={analytics.stateData} />
              </div>
            </div>
            <div className="flex flex-col">
              <DataTable<(typeof analytics.cityBreakdown)[number]>
                columns={[
                  {
                    key: "city",
                    label: "City",
                    render: (r) => (
                      <span className="text-body-sm">{r.label}</span>
                    ),
                  },
                  {
                    key: "count",
                    label: "Events",
                    align: "right",
                    render: (r) => r.count.toLocaleString(),
                  },
                ]}
                rows={analytics.cityBreakdown.slice(0, 25)}
                rowKey={(r) =>
                  `${r.country_code ?? ""}|${r.region_code ?? ""}|${r.city}`
                }
                emptyMessage="No location data available for this window."
                maxHeightClass="max-h-80"
              />
            </div>
          </div>
        </section>

        <div className="mt-10 grid grid-cols-1 gap-4 lg:grid-cols-2">
          <TopPerformersCard
            performers={topPerformers}
            titleSlug={primarySlug}
            titleName={primaryName}
          />
          <TopCreatorsCard creators={topCreators} />
        </div>

        {titleRows.filter((t) => t.is_active).length > 1 && (
          <section className="mt-10 flex flex-col gap-3">
            <h2 className="text-heading-lg md:text-display-sm m-0">Titles</h2>
            <p className="text-body-sm text-moonbeem-ink-muted m-0">
              Every active title in this catalog. View counts are
              lifetime; modal opens, platform clicks, and /go/ clicks
              are window-scoped.
            </p>
            <PerTitleRollup
              titles={titleRows.filter((t) => t.is_active)}
              perTitle={analytics.perTitle}
              isSuperAdmin={isSuperAdmin}
            />
          </section>
        )}

        <div className="mt-10">
          <RequestedTitlesCard requestedTitles={requestedTitles} />
        </div>

        <div className="mt-10">
          <PartnerRatesCard
            partnerSlug={partner.slug as string}
            isAdmin={isPartnerAdmin}
            titles={titleRates}
            paid_this_month_cents={paidThisMonthCents}
            unique_creators_paid={creatorsThisMonth.size}
          />
        </div>

        <div className="mt-10 rounded-2xl border border-white/10 bg-white/[0.02] p-5">
          <div className="flex items-center gap-3">
            <span className="rounded-full bg-moonbeem-violet/20 px-2.5 py-0.5 text-caption font-medium text-moonbeem-violet-soft">
              Growth
            </span>
            <span className="text-caption text-moonbeem-ink-subtle">
              views tracked since May 5 · daily
            </span>
          </div>
          <div className="mt-4">
            <GrowthChart data={dailyGrowth} />
          </div>
          {trackingStartDay && (
            <p className="mt-3 text-caption text-moonbeem-ink-subtle">
              View tracking began{" "}
              {new Date(trackingStartDay + "T00:00:00Z").toLocaleDateString(
                undefined,
                { year: "numeric", month: "long", day: "numeric" },
              )}
              ; the chart counts views measured since tracking began,
              so its total runs lower than the lifetime figure above.
            </p>
          )}
        </div>

        <div className="mt-10">
          <div className="mb-4 flex items-center gap-3">
            <span className="rounded-full bg-moonbeem-pink/15 px-2.5 py-0.5 text-caption font-medium text-moonbeem-pink">
              All fan edits
            </span>
            <span className="text-caption text-moonbeem-ink-subtle">
              {allEdits.length} active · click columns to sort
            </span>
          </div>
          <AllEditsTable
            rows={allEdits}
            titleSlug={primarySlug}
            titleName={primaryName}
          />
        </div>
      </div>
    </div>
  );
}
