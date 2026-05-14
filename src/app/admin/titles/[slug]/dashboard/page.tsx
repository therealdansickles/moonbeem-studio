// /admin/titles/[slug]/dashboard — per-title editorial dashboard.
//
// Same primitives + window-toggle pattern as /admin/dashboard, but
// every metric scoped to a single title resolved by slug. Six hero
// tiles drop "Active titles" (irrelevant single-title) and gain
// "Total social views" (lifetime sum of fan_edit.view_count across
// this title's edits — the headline EnsembleData metric).
//
// Cross-fan_edit comparison table at the bottom: every active fan
// edit for this title, ranked by view_count, with window-scoped
// modal opens + platform clicks per edit. Lets the admin see which
// individual fan edits drive the title's engagement.
//
// Auth: requireSuperAdminOr404 (404 hides existence). Scope is
// computed server-side; no client state.

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
  title: "Title dashboard · Moonbeem admin",
  robots: { index: false, follow: false },
};

type EventRow = {
  fan_edit_id: string;
  event_type: string;
  user_id: string | null;
  created_at: string;
};

type ClickRow = {
  country_code: string | null;
  region_code: string | null;
  clicked_at: string;
};

type FanEditRow = {
  id: string;
  platform: string;
  embed_url: string;
  caption: string | null;
  view_count: number | null;
  creator_id: string | null;
  creator_handle_displayed: string | null;
  thumbnail_url: string | null;
};

type FanEditWithEngagement = FanEditRow & {
  modal_opens: number;
  platform_clicks: number;
  creator_handle: string;
};

type PageProps = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ window?: string | string[] }>;
};

export default async function AdminTitleDashboardPage(props: PageProps) {
  await requireSuperAdminOr404();
  const { slug } = await props.params;
  const sp = await props.searchParams;
  const win = parseWindow(sp.window);
  const cutoff = windowCutoffIso(win);

  const supabase = createServiceRoleClient();

  // Resolve title by slug.
  const { data: title } = await supabase
    .from("titles")
    .select("id, slug, title, partner_id, poster_url")
    .eq("slug", slug)
    .maybeSingle();
  if (!title) notFound();
  const titleId = title.id as string;

  // All active fan_edits for this title — drives comparison table,
  // creator aggregation, view-count sum, and the fan_edit_id filter
  // for events.
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

  // Open requests for this title
  const openRequestsCountQ = supabase
    .from("title_requests")
    .select("id", { count: "exact", head: true })
    .eq("title_id", titleId)
    .is("fulfilled_at", null)
    .eq("request_type", "fan_edits");

  // /go/ clicks for this title, window-filtered, humans only
  const clicksQ = (() => {
    let q = supabase
      .from("external_clicks")
      .select("country_code, region_code, clicked_at")
      .eq("title_id", titleId)
      .eq("is_bot", false);
    if (cutoff) q = q.gte("clicked_at", cutoff);
    return q;
  })();

  // Partner name (for header context)
  const partnerQ = title.partner_id
    ? supabase
        .from("partners")
        .select("name, slug")
        .eq("id", title.partner_id as string)
        .maybeSingle()
    : Promise.resolve({ data: null });

  const [fanEditsRes, openRequestsRes, clicksRes, partnerRes] =
    await Promise.all([
      fanEditsForTitleQ,
      openRequestsCountQ,
      clicksQ,
      partnerQ,
    ]);

  const fanEdits = (fanEditsRes.data ?? []) as FanEditRow[];
  const fanEditIds = fanEdits.map((fe) => fe.id);
  const clicks = (clicksRes.data ?? []) as ClickRow[];

  // Events query depends on fan_edit_ids — fetch after we know them.
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

  // Hero metrics
  const totalSocialViews = fanEdits.reduce(
    (s, fe) => s + ((fe.view_count as number | null) ?? 0),
    0,
  );
  const uniqueSignedInUsers = new Set(
    events
      .map((e) => e.user_id)
      .filter((id): id is string => Boolean(id)),
  ).size;

  // Time series
  const timeSeries = bucketTimeSeries(
    events.map((e) => e.created_at),
    win,
  );

  // Geo
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

  // Per-fan_edit engagement counts (window-scoped)
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

  // Hydrate creator handles for the comparison table.
  const creatorIds = Array.from(
    new Set(
      fanEdits.map((fe) => fe.creator_id).filter((id): id is string => Boolean(id)),
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

  const fanEditsWithEngagement: FanEditWithEngagement[] = fanEdits.map((fe) => ({
    ...fe,
    modal_opens: modalOpensByFe.get(fe.id) ?? 0,
    platform_clicks: platformClicksByFe.get(fe.id) ?? 0,
    creator_handle:
      (fe.creator_id && handleByCreatorId.get(fe.creator_id)) ||
      fe.creator_handle_displayed ||
      "anon",
  }));

  const partnerName =
    (partnerRes.data?.name as string | undefined) ?? null;
  const partnerSlug =
    (partnerRes.data?.slug as string | undefined) ?? null;

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
              {title.title as string}
            </h1>
            <p className="text-body text-moonbeem-ink-muted m-0">
              Title dashboard ·{" "}
              {partnerName && partnerSlug ? (
                <>
                  <Link
                    href={`/admin/partners/${partnerSlug}/dashboard`}
                    className="hover:text-moonbeem-pink"
                  >
                    {partnerName}
                  </Link>
                  {" · "}
                </>
              ) : null}
              {windowLabel(win)}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Link
              href={`/t/${slug}`}
              className="text-body-sm text-moonbeem-ink-muted hover:text-moonbeem-pink"
            >
              Public page →
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
                href={`/admin/titles/${slug}/dashboard?window=${w}`}
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
            value={fanEdits.length.toLocaleString()}
            label="Active fan edits"
          />
          <HeroNumber
            value={(openRequestsRes.count ?? 0).toLocaleString()}
            label="Open title requests"
          />
        </section>

        {/* Time-series */}
        <section className="flex flex-col gap-3">
          <h2 className="text-display-sm m-0">Engagement over time</h2>
          <p className="text-body-sm text-moonbeem-ink-muted m-0">
            Fan-edit modal events for this title ·{" "}
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
            /go/ click origins for this title · {totalGeoClicks.toLocaleString()}{" "}
            geo-tagged click{totalGeoClicks === 1 ? "" : "s"} in window
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

        {/* Cross-fan_edit comparison */}
        <section className="flex flex-col gap-3">
          <h2 className="text-display-sm m-0">Fan edits</h2>
          <p className="text-body-sm text-moonbeem-ink-muted m-0">
            Every active fan edit for this title. View counts are
            lifetime; modal opens and platform clicks are window-scoped.
          </p>
          <DataTable<FanEditWithEngagement>
            columns={getFanEditComparisonColumns()}
            rows={fanEditsWithEngagement}
            rowKey={(r) => r.id}
            emptyMessage="No active fan edits for this title yet."
          />
        </section>
      </div>
    </div>
  );
}

function getFanEditComparisonColumns(): Column<FanEditWithEngagement>[] {
  return [
    {
      key: "thumb",
      label: "",
      render: (r) =>
        r.thumbnail_url ? (
          <div className="h-[60px] w-[40px] shrink-0 overflow-hidden rounded-sm bg-white/[0.03]">
            <Image
              src={r.thumbnail_url}
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
      key: "creator",
      label: "Creator / platform",
      render: (r) => (
        <div className="flex flex-col">
          <Link
            href={`/admin/fan-edits/${r.id}`}
            className="text-moonbeem-pink hover:opacity-90 text-body-sm"
          >
            @{r.creator_handle}
          </Link>
          <span className="text-caption text-moonbeem-ink-subtle">
            {r.platform}
          </span>
        </div>
      ),
    },
    {
      key: "caption",
      label: "Caption",
      render: (r) => (
        <span className="text-body-sm text-moonbeem-ink-muted line-clamp-2 max-w-[280px] block">
          {r.caption ?? "—"}
        </span>
      ),
    },
    {
      key: "views",
      label: "Views",
      align: "right",
      render: (r) => (r.view_count ?? 0).toLocaleString(),
    },
    {
      key: "opens",
      label: "Modal opens",
      align: "right",
      render: (r) => r.modal_opens.toLocaleString(),
    },
    {
      key: "clicks",
      label: "Platform clicks",
      align: "right",
      render: (r) => r.platform_clicks.toLocaleString(),
    },
  ];
}
