// /admin/partners/[slug]/dashboard — per-partner editorial dashboard.
//
// Same primitives + window-toggle pattern as the platform and title
// dashboards, but every metric scoped to a single partner's catalog
// of titles. "Active titles" reappears in the hero row (replacing
// the per-title dashboard's "Active fan edits" since multi-title
// roll-up makes title count the more informative top-line).
//
// Multi-title comparison table at the bottom: every active title in
// the partner's catalog, ranked by total social views. Per-title:
// fan-edit count, total social views, window-scoped modal opens +
// /go/ clicks, open requests.
//
// Auth: requireSuperAdminOr404. Scope is computed server-side via
// title.partner_id; partner-team-facing variant (with RLS rather
// than super-admin gate) is a future surface.

import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Image from "next/image";
import { requireSuperAdminOr404 } from "@/lib/dal";
import { createServiceRoleClient } from "@/lib/supabase/service";
import HeroNumber from "@/components/dashboard/HeroNumber";
import TimeSeriesChart from "@/components/dashboard/TimeSeriesChart";
import UsStateChoropleth from "@/components/dashboard/UsStateChoropleth";
import DataTable, { type Column } from "@/components/dashboard/DataTable";
import {
  parseWindow,
  windowCutoffIso,
  windowLabel,
  windowShortLabel,
  bucketTimeSeries,
  countByState,
  countByCountry,
  TIME_WINDOWS,
} from "@/lib/dashboard/queries";

export const metadata: Metadata = {
  title: "Partner dashboard · Moonbeem admin",
  robots: { index: false, follow: false },
};

type EventRow = {
  fan_edit_id: string;
  event_type: string;
  user_id: string | null;
  created_at: string;
};

type ClickRow = {
  title_id: string;
  country_code: string | null;
  region_code: string | null;
  clicked_at: string;
};

type FanEditRow = {
  id: string;
  title_id: string;
  view_count: number | null;
};

type TitleRow = {
  id: string;
  slug: string;
  title: string;
  poster_url: string | null;
};

type TitleWithEngagement = TitleRow & {
  fan_edit_count: number;
  total_social_views: number;
  modal_opens: number;
  platform_clicks: number;
  go_clicks: number;
  open_requests: number;
};

type PageProps = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ window?: string | string[] }>;
};

export default async function AdminPartnerDashboardPage(props: PageProps) {
  await requireSuperAdminOr404();
  const { slug } = await props.params;
  const sp = await props.searchParams;
  const win = parseWindow(sp.window);
  const cutoff = windowCutoffIso(win);

  const supabase = createServiceRoleClient();

  // Resolve partner by slug.
  const { data: partner } = await supabase
    .from("partners")
    .select("id, slug, name, logo_url")
    .eq("slug", slug)
    .maybeSingle();
  if (!partner) notFound();
  const partnerId = partner.id as string;

  // All active titles for this partner
  const { data: titlesData } = await supabase
    .from("titles")
    .select("id, slug, title, poster_url")
    .eq("partner_id", partnerId)
    .eq("is_active", true)
    .is("deleted_at", null);
  const titles = (titlesData ?? []) as TitleRow[];
  const titleIds = titles.map((t) => t.id);

  // No titles: render an empty-state and bail early. Avoids the
  // .in("title_id", []) gotcha (Supabase returns all rows on empty
  // IN clause).
  if (titleIds.length === 0) {
    return (
      <div className="min-h-screen bg-[radial-gradient(ellipse_at_top,_#1a0f3a_0%,_#0a0a14_60%)] px-6 py-12 text-moonbeem-ink">
        <div className="mx-auto max-w-6xl flex flex-col gap-6">
          <h1 className="font-wordmark text-display-lg text-moonbeem-ink m-0">
            {partner.name as string}
          </h1>
          <p className="text-body text-moonbeem-ink-muted m-0">
            No active titles for this partner yet.
          </p>
          <Link
            href="/admin/dashboard"
            className="text-body-sm text-moonbeem-ink-muted hover:text-moonbeem-pink"
          >
            ← Platform dashboard
          </Link>
        </div>
      </div>
    );
  }

  // Active fan_edits for the partner's titles (full set drives all
  // multi-title aggregations — fan_edit_count, view sum, event filter)
  const fanEditsQ = supabase
    .from("fan_edits")
    .select("id, title_id, view_count")
    .in("title_id", titleIds)
    .eq("is_active", true)
    .eq("verification_status", "auto_verified")
    .is("deleted_at", null);

  // /go/ clicks for the partner's titles, window-filtered, humans only
  const clicksQ = (() => {
    let q = supabase
      .from("external_clicks")
      .select("title_id, country_code, region_code, clicked_at")
      .in("title_id", titleIds)
      .eq("is_bot", false);
    if (cutoff) q = q.gte("clicked_at", cutoff);
    return q;
  })();

  // Open requests across the partner's titles (count by title_id later)
  const openRequestsQ = supabase
    .from("title_requests")
    .select("title_id")
    .in("title_id", titleIds)
    .is("fulfilled_at", null)
    .eq("request_type", "fan_edits");

  const [fanEditsRes, clicksRes, openRequestsRes] = await Promise.all([
    fanEditsQ,
    clicksQ,
    openRequestsQ,
  ]);

  const fanEdits = (fanEditsRes.data ?? []) as FanEditRow[];
  const clicks = (clicksRes.data ?? []) as ClickRow[];
  const openRequests = (openRequestsRes.data ?? []) as { title_id: string }[];

  // Events: filter by fan_edit_id ∈ partner's fan_edits
  const fanEditIds = fanEdits.map((fe) => fe.id);
  const events: EventRow[] = await (async () => {
    if (fanEditIds.length === 0) return [];
    let q = supabase
      .from("fan_edit_events")
      .select("fan_edit_id, event_type, user_id, created_at")
      .in("fan_edit_id", fanEditIds);
    if (cutoff) q = q.gte("created_at", cutoff);
    const r = await q;
    return (r.data ?? []) as EventRow[];
  })();

  // Hero aggregates
  const totalSocialViews = fanEdits.reduce(
    (s, fe) => s + ((fe.view_count as number | null) ?? 0),
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
  const countryBreakdown = countByCountry(
    clicks.map((c) => ({ country_code: c.country_code })),
  );
  const totalGeoClicks = countryBreakdown.reduce((s, c) => s + c.count, 0);

  // Multi-title roll-up
  // Index fan_edits by title for fan_edit_count + view sum + event mapping
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
      (socialViewsByTitle.get(fe.title_id) ?? 0) +
        ((fe.view_count as number | null) ?? 0),
    );
  }
  const titleByFanEdit = new Map<string, string>();
  for (const [tid, ids] of fanEditIdsByTitle) {
    for (const fid of ids) titleByFanEdit.set(fid, tid);
  }
  // Window-scoped per-title engagement aggregations
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

  const titlesWithEngagement: TitleWithEngagement[] = titles
    .map((t) => ({
      ...t,
      fan_edit_count: fanEditCountByTitle.get(t.id) ?? 0,
      total_social_views: socialViewsByTitle.get(t.id) ?? 0,
      modal_opens: modalOpensByTitle.get(t.id) ?? 0,
      platform_clicks: platformClicksByTitle.get(t.id) ?? 0,
      go_clicks: goClicksByTitle.get(t.id) ?? 0,
      open_requests: openRequestsByTitle.get(t.id) ?? 0,
    }))
    .sort((a, b) => b.total_social_views - a.total_social_views);

  return (
    <div className="min-h-screen bg-[radial-gradient(ellipse_at_top,_#1a0f3a_0%,_#0a0a14_60%)] px-6 py-12 text-moonbeem-ink">
      <div className="mx-auto max-w-6xl flex flex-col gap-10">
        {/* Header */}
        <div className="flex items-baseline justify-between gap-4 flex-wrap">
          <div className="flex flex-col gap-1 min-w-0">
            <span className="font-wordmark text-heading-md text-moonbeem-pink">
              moonbeem.
            </span>
            <h1 className="font-wordmark text-display-lg text-moonbeem-ink m-0 truncate">
              {partner.name as string}
            </h1>
            <p className="text-body text-moonbeem-ink-muted m-0">
              Partner dashboard · {windowLabel(win)}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Link
              href={`/p/${slug}/dashboard`}
              className="text-body-sm text-moonbeem-ink-muted hover:text-moonbeem-pink"
            >
              Partner-facing →
            </Link>
            <Link
              href="/admin/dashboard"
              className="text-body-sm text-moonbeem-ink-muted hover:text-moonbeem-pink"
            >
              ← Platform dashboard
            </Link>
          </div>
        </div>

        {/* Window toggle */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-body-sm text-moonbeem-ink-muted mr-1">
            Window:
          </span>
          {TIME_WINDOWS.map((w) => {
            const active = w === win;
            return (
              <Link
                key={w}
                href={`/admin/partners/${slug}/dashboard?window=${w}`}
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
        </div>

        {/* Hero row */}
        <section className="grid grid-cols-2 gap-3 md:grid-cols-3 md:gap-4">
          <HeroNumber
            value={events.length.toLocaleString()}
            label="Engagement events"
          />
          <HeroNumber
            value={uniqueSignedInUsers.toLocaleString()}
            label="Signed-in users (window)"
          />
          <HeroNumber
            value={clicks.length.toLocaleString()}
            label="/go/ clicks (humans)"
          />
          <HeroNumber
            value={totalSocialViews.toLocaleString()}
            label="Total social views"
          />
          <HeroNumber
            value={titles.length.toLocaleString()}
            label="Active titles"
          />
          <HeroNumber
            value={openRequests.length.toLocaleString()}
            label="Open title requests"
          />
        </section>

        {/* Time-series */}
        <section className="flex flex-col gap-3">
          <h2 className="text-display-sm m-0">Engagement over time</h2>
          <p className="text-body-sm text-moonbeem-ink-muted m-0">
            Fan-edit modal events across this partner&apos;s catalog ·{" "}
            {win === "24h" ? "hourly" : "daily"} buckets
          </p>
          <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
            {timeSeries.length === 0 ? (
              <p className="text-body-sm text-moonbeem-ink-muted text-center py-12 m-0">
                No engagement events in this window.
              </p>
            ) : (
              <TimeSeriesChart data={timeSeries} yLabel="events" />
            )}
          </div>
        </section>

        {/* Geo */}
        <section className="flex flex-col gap-3">
          <h2 className="text-display-sm m-0">Geography</h2>
          <p className="text-body-sm text-moonbeem-ink-muted m-0">
            /go/ click origins across this partner&apos;s catalog ·{" "}
            {totalGeoClicks.toLocaleString()} geo-tagged click
            {totalGeoClicks === 1 ? "" : "s"} in window
          </p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="md:col-span-2 rounded-2xl border border-white/10 bg-white/[0.02] p-4">
              <UsStateChoropleth data={stateData} height={360} />
            </div>
            <div className="flex flex-col">
              <DataTable<{ country_code: string; count: number }>
                columns={[
                  {
                    key: "country",
                    label: "Country",
                    render: (r) => (
                      <span className="font-mono text-body-sm">
                        {r.country_code}
                      </span>
                    ),
                  },
                  {
                    key: "count",
                    label: "Clicks",
                    align: "right",
                    render: (r) => r.count.toLocaleString(),
                  },
                ]}
                rows={countryBreakdown.slice(0, 10)}
                rowKey={(r) => r.country_code}
                emptyMessage="No geo-tagged clicks in this window."
              />
            </div>
          </div>
        </section>

        {/* Multi-title comparison */}
        <section className="flex flex-col gap-3">
          <h2 className="text-display-sm m-0">Titles</h2>
          <p className="text-body-sm text-moonbeem-ink-muted m-0">
            Every active title in this partner&apos;s catalog. View counts
            are lifetime; modal opens, platform clicks, and /go/ clicks
            are window-scoped.
          </p>
          <DataTable<TitleWithEngagement>
            columns={getTitleComparisonColumns()}
            rows={titlesWithEngagement}
            rowKey={(r) => r.id}
            emptyMessage="No active titles."
          />
        </section>
      </div>
    </div>
  );
}

function getTitleComparisonColumns(): Column<TitleWithEngagement>[] {
  return [
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
      render: (r) => (
        <Link
          href={`/admin/titles/${r.slug}/dashboard`}
          className="text-moonbeem-ink hover:text-moonbeem-pink text-body-sm truncate block max-w-[260px]"
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
      key: "goclicks",
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
}
