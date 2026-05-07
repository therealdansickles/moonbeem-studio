// Partner dashboard — public-but-obscure URL at /p/[slug].
//
// v1 has one partner (1-2 Special, slug '1-2-special') and no auth
// gate; partners bookmark the URL. Multi-tenant ready: data already
// scoped by titles.partner_id, just add RLS / membership when a
// second partner onboards.
//
// All reads via service-role client on the server. RLS on the
// underlying tables (fan_edits, fan_edit_events, external_clicks,
// view_tracking_snapshots) doesn't have public SELECT policies, so
// service role is required.

import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getUser } from "@/lib/dal";
import { createServiceRoleClient } from "@/lib/supabase/service";
import PlatformIcon from "@/components/PlatformIcon";
import GrowthChart from "@/components/p/GrowthChart";
import AllEditsTable from "@/components/p/AllEditsTable";
import PartnerRatesCard from "@/components/p/PartnerRatesCard";
import { formatMetric } from "@/lib/format";

type SocialPlatform = "tiktok" | "instagram" | "twitter" | "youtube";

const platformLabel: Record<SocialPlatform, string> = {
  tiktok: "TikTok",
  instagram: "Instagram",
  twitter: "X",
  youtube: "YouTube",
};

type PageProps = { params: Promise<{ slug: string }> };

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

  const { data: fanEdits } = await supabase
    .from("fan_edits")
    .select("id, view_count, creator_id")
    .in("title_id", titleIds)
    .eq("view_tracking_status", "active");

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
  creator_handle: string | null;
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
    .select("id, platform, view_count, thumbnail_url, creator_id")
    .in("title_id", titleIds)
    .eq("view_tracking_status", "active")
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
    .eq("view_tracking_status", "active")
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

// Stable per-handle background color for initial avatars.
function avatarHueForHandle(handle: string): number {
  let hash = 0;
  for (let i = 0; i < handle.length; i++) {
    hash = (hash * 31 + handle.charCodeAt(i)) >>> 0;
  }
  return hash % 360;
}

function InitialAvatar({ handle }: { handle: string }) {
  const initial = handle[0]?.toUpperCase() ?? "?";
  const hue = avatarHueForHandle(handle);
  return (
    <div
      style={{
        background:
          `linear-gradient(135deg, hsl(${hue} 70% 50%), hsl(${(hue + 40) % 360} 70% 35%))`,
      }}
      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full font-wordmark text-body-sm font-semibold text-white"
    >
      {initial}
    </div>
  );
}

function GrowthBadge({
  delta,
  pct,
}: {
  delta: number | null;
  pct: number | null;
}) {
  if (delta === null) {
    return (
      <span className="text-caption text-moonbeem-ink-subtle tabular-nums">
        —
      </span>
    );
  }
  const positive = delta >= 0;
  const sign = positive ? "+" : "";
  const pctTxt = pct !== null
    ? ` (${pct >= 0 ? "+" : ""}${pct.toFixed(pct >= 10 || pct <= -10 ? 0 : 1)}%)`
    : "";
  return (
    <span
      className={`text-caption tabular-nums ${
        positive ? "text-emerald-300" : "text-moonbeem-magenta"
      }`}
    >
      {sign}
      {formatMetric(Math.abs(delta))}
      {pctTxt}
    </span>
  );
}

function TopPerformersCard({
  performers,
  titleSlug,
}: {
  performers: TopPerformer[];
  titleSlug: string;
}) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
      <div className="flex items-center gap-3">
        <span className="rounded-full bg-moonbeem-pink/15 px-2.5 py-0.5 text-caption font-medium text-moonbeem-pink">
          Top performers
        </span>
        <span className="text-caption text-moonbeem-ink-subtle">
          by view count
        </span>
      </div>
      <ol className="mt-4 flex flex-col divide-y divide-white/5">
        {performers.map((fe, i) => (
          <li key={fe.id} className="flex items-center gap-3 py-3">
            <span className="w-5 shrink-0 text-caption tabular-nums text-moonbeem-ink-subtle">
              {i + 1}
            </span>
            <Link
              href={`/t/${titleSlug}#fan-edits`}
              className="relative h-12 w-12 shrink-0 overflow-hidden rounded-md bg-moonbeem-navy/40"
            >
              {fe.thumbnail_url
                ? (
                  <Image
                    src={fe.thumbnail_url}
                    alt=""
                    fill
                    sizes="48px"
                    unoptimized
                    className="object-cover"
                  />
                )
                : null}
            </Link>
            <div className="flex min-w-0 flex-1 flex-col">
              {fe.creator_handle
                ? (
                  <Link
                    href={`/c/${fe.creator_handle}`}
                    className="truncate text-body-sm font-medium text-moonbeem-ink hover:text-moonbeem-pink"
                  >
                    @{fe.creator_handle}
                  </Link>
                )
                : (
                  <span className="text-body-sm text-moonbeem-ink-subtle">
                    @anon
                  </span>
                )}
              <span className="flex items-center gap-1.5 text-caption text-moonbeem-ink-subtle">
                <PlatformIcon platform={fe.platform} className="h-3 w-3" />
                {platformLabel[fe.platform]}
              </span>
            </div>
            <div className="flex flex-col items-end">
              <span className="text-body-sm font-semibold tabular-nums text-moonbeem-ink">
                {formatMetric(fe.view_count)}
              </span>
              <GrowthBadge delta={fe.growth_24h} pct={fe.growth_pct_24h} />
            </div>
          </li>
        ))}
      </ol>
    </div>
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

// Daily-summed total views across all of partner's fan_edits. Per
// (fan_edit_id, day) we keep the day's max view_count, then forward-
// fill so days without a snapshot for a given edit still contribute
// the most recent prior value to the daily sum. Fixes the
// "Tuesday's total drops because we only refreshed half the catalog
// on Tuesday" artefact.
async function loadDailyGrowth(
  supabase: ReturnType<typeof createServiceRoleClient>,
  fanEditIds: string[],
  lookbackDays = 30,
): Promise<Array<{ day: string; views: number }>> {
  if (fanEditIds.length === 0) return [];
  const cutoff = new Date(
    Date.now() - lookbackDays * 24 * 60 * 60 * 1000,
  ).toISOString();
  const { data: snaps } = await supabase
    .from("view_tracking_snapshots")
    .select("fan_edit_id, view_count, captured_at")
    .in("fan_edit_id", fanEditIds)
    .gte("captured_at", cutoff)
    .order("captured_at", { ascending: true });

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

  const sortedDays = [...allDays].sort();
  const editLatest = new Map<string, number>();
  return sortedDays.map((d) => {
    for (const [fid, days] of perEditPerDay) {
      if (days.has(d)) editLatest.set(fid, days.get(d)!);
    }
    let total = 0;
    for (const v of editLatest.values()) total += v;
    return { day: d, views: total };
  });
}

type AllEditRow = {
  id: string;
  platform: SocialPlatform;
  thumbnail_url: string | null;
  creator_handle: string | null;
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
    .select("id, platform, view_count, thumbnail_url, creator_id")
    .in("title_id", titleIds)
    .eq("view_tracking_status", "active")
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
          Top fan editors
        </span>
        <span className="text-caption text-moonbeem-ink-subtle">
          by total views
        </span>
      </div>
      <ol className="mt-4 flex flex-col divide-y divide-white/5">
        {creators.map((c, i) => (
          <li key={c.creator_id} className="flex items-center gap-3 py-3">
            <span className="w-5 shrink-0 text-caption tabular-nums text-moonbeem-ink-subtle">
              {i + 1}
            </span>
            <InitialAvatar handle={c.handle} />
            <div className="flex min-w-0 flex-1 flex-col">
              <Link
                href={`/c/${c.handle}`}
                className="truncate text-body-sm font-medium text-moonbeem-ink hover:text-moonbeem-pink"
              >
                @{c.handle}
              </Link>
              <span className="text-caption text-moonbeem-ink-subtle">
                {c.edit_count} {c.edit_count === 1 ? "edit" : "edits"}
              </span>
            </div>
            <span className="text-body-sm font-semibold tabular-nums text-moonbeem-ink">
              {formatMetric(c.total_views)}
            </span>
          </li>
        ))}
      </ol>
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
    <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
      <div className="font-wordmark text-display-md text-moonbeem-pink leading-none">
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

export default async function PartnerDashboardPage({ params }: PageProps) {
  const { slug } = await params;

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

  const { data: membership } = await supabase
    .from("partner_users")
    .select("role")
    .eq("partner_id", partner.id)
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!membership) notFound();
  const isPartnerAdmin = membership.role === "admin";

  const { data: titles } = await supabase
    .from("titles")
    .select("id, slug, title")
    .eq("partner_id", partner.id);
  const titleRows = titles ?? [];
  const titleIds = titleRows.map((t) => t.id as string);

  const [metrics, topPerformers, topCreators, allEdits] = await Promise.all([
    loadHeroMetrics(supabase, titleIds),
    loadTopPerformers(supabase, titleIds, 10),
    loadTopCreators(supabase, titleIds, 10),
    loadAllEdits(supabase, titleIds),
  ]);
  const dailyGrowth = await loadDailyGrowth(
    supabase,
    allEdits.map((r) => r.id),
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

  return (
    <div className="min-h-screen px-6 py-12 bg-[radial-gradient(ellipse_at_top,_#1a0f3a_0%,_#0a0a14_60%)]">
      <div className="mx-auto max-w-6xl">
        <div className="flex items-center justify-between">
          <span className="font-wordmark text-heading-md text-moonbeem-pink">
            moonbeem.
          </span>
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
          <h1 className="font-wordmark text-display-lg text-moonbeem-ink m-0">
            {partner.name}
          </h1>
          <p className="text-body text-moonbeem-ink-muted m-0">
            {titleSummary} · partnership dashboard
          </p>
        </div>

        <div className="mt-10 grid grid-cols-2 gap-4 lg:grid-cols-4">
          <HeroTile
            value={formatMetric(metrics.total_views)}
            label="Total platform views"
            sub={`across ${titleRows.length === 1 ? "the title's" : "all"} fan edits`}
          />
          <HeroTile
            value={metrics.unique_creators.toLocaleString()}
            label="Unique fan creators"
          />
          <HeroTile
            value={formatMetric(metrics.modal_opens)}
            label="Moonbeem modal opens"
            sub="on-platform engagement"
          />
          <HeroTile
            value={metrics.ticket_clicks.toLocaleString()}
            label="Ticket click-throughs"
            sub="outbound to listings"
          />
        </div>

        <div className="mt-10 grid grid-cols-1 gap-4 lg:grid-cols-2">
          <TopPerformersCard
            performers={topPerformers}
            titleSlug={primarySlug}
          />
          <TopCreatorsCard creators={topCreators} />
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
              total views over time
            </span>
          </div>
          <div className="mt-4">
            <GrowthChart data={dailyGrowth} />
          </div>
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
          <AllEditsTable rows={allEdits} titleSlug={primarySlug} />
        </div>
      </div>
    </div>
  );
}
