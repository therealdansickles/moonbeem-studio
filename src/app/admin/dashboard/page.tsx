// /admin/dashboard — platform-wide editorial dashboard.
//
// Server component. Auth via requireSuperAdminOr404 (404 hides
// existence; same gate as /admin). Reads ?window= search param to
// scope time-filtered metrics; defaults to 7d.
//
// Sections (top to bottom):
//   1. Header — title + breadcrumb back to /admin + time-window toggle
//   2. Hero row — 6 HeroNumber tiles (events, signed-in users, active
//      titles, active fan_edits, /go/ clicks, open requests)
//   3. Time-series chart — events per day (or per hour for 24h) over
//      the window
//   4. Geo — US-state choropleth (events by state from /go/ clicks)
//      + country-breakdown table beneath
//   5. Top performers — top 10 fan_edits + top 10 creators
//
// Data scoping for v1: platform-wide (no title or partner filter).
// Per-title and per-partner variants come in Stages 3-4 reusing the
// same primitives.

import Link from "next/link";
import type { Metadata } from "next";
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
  countByCity,
  TIME_WINDOWS,
} from "@/lib/dashboard/queries";

export const metadata: Metadata = {
  title: "Dashboard · Moonbeem admin",
  robots: { index: false, follow: false },
};

type EventRow = {
  user_id: string | null;
  created_at: string;
  country_code: string | null;
  region_code: string | null;
  city: string | null;
};

type ClickRow = {
  country_code: string | null;
  region_code: string | null;
  city: string | null;
  clicked_at: string;
};

type FanEditRow = {
  id: string;
  title_id: string;
  view_count: number | null;
  creator_id: string | null;
  creator_handle_displayed: string | null;
  embed_url: string;
  thumbnail_url: string | null;
  titles?: { slug: string | null; title: string | null } | null;
};

type CreatorAgg = {
  creator_id: string;
  handle: string;
  view_count: number;
  fan_edit_count: number;
};

type PageProps = {
  searchParams: Promise<{ window?: string | string[] }>;
};

export default async function AdminDashboardPage(props: PageProps) {
  await requireSuperAdminOr404();
  const sp = await props.searchParams;
  const win = parseWindow(sp.window);
  const cutoff = windowCutoffIso(win);

  const supabase = createServiceRoleClient();

  // Events query (window-filtered). Pulls geo columns too so the
  // city table can combine consent-gated event geo with /go/ click
  // geo into one ranking.
  const eventsQ = (() => {
    let q = supabase
      .from("fan_edit_events")
      .select("user_id, created_at, country_code, region_code, city");
    if (cutoff) q = q.gte("created_at", cutoff);
    return q;
  })();

  // /go/ clicks (window-filtered, humans only — bot-inflated counts
  // are not the right partner-facing signal even on a super-admin
  // page; we surface true engagement)
  const clicksQ = (() => {
    let q = supabase
      .from("external_clicks")
      .select("country_code, region_code, city, clicked_at")
      .eq("is_bot", false);
    if (cutoff) q = q.gte("clicked_at", cutoff);
    return q;
  })();

  // Top fan_edits — by view_count (lifetime, not window-scoped; the
  // view_count signal is cumulative from EnsembleData and a window
  // filter would not produce a meaningful slice today)
  const topFanEditsQ = supabase
    .from("fan_edits")
    .select(
      "id, title_id, view_count, creator_id, creator_handle_displayed, embed_url, thumbnail_url, titles(slug, title)",
    )
    .eq("is_active", true)
    .eq("verification_status", "auto_verified")
    .is("deleted_at", null)
    .order("view_count", { ascending: false, nullsFirst: false })
    .limit(10);

  // Active counts — not window-scoped (these are absolute state)
  const titlesCountQ = supabase
    .from("titles")
    .select("id", { count: "exact", head: true })
    .eq("is_active", true)
    .is("deleted_at", null);
  const fanEditsCountQ = supabase
    .from("fan_edits")
    .select("id", { count: "exact", head: true })
    .eq("is_active", true)
    .eq("verification_status", "auto_verified")
    .is("deleted_at", null);
  const openRequestsCountQ = supabase
    .from("title_requests")
    .select("id", { count: "exact", head: true })
    .is("fulfilled_at", null)
    .eq("request_type", "fan_edits");

  // All active fan_edits for creator aggregation (we group in JS).
  // At 256 active fan_edits this is a small payload; if it ever grows
  // past ~10K we'd move to a SQL aggregation.
  const allEditsForCreatorsQ = supabase
    .from("fan_edits")
    .select("creator_id, creator_handle_displayed, view_count")
    .eq("is_active", true)
    .eq("verification_status", "auto_verified")
    .is("deleted_at", null)
    .not("creator_id", "is", null);

  const [
    eventsRes,
    clicksRes,
    topFanEditsRes,
    titlesCountRes,
    fanEditsCountRes,
    openRequestsCountRes,
    allEditsForCreatorsRes,
  ] = await Promise.all([
    eventsQ,
    clicksQ,
    topFanEditsQ,
    titlesCountQ,
    fanEditsCountQ,
    openRequestsCountQ,
    allEditsForCreatorsQ,
  ]);

  const events = (eventsRes.data ?? []) as EventRow[];
  const clicks = (clicksRes.data ?? []) as ClickRow[];
  const topFanEdits = (topFanEditsRes.data ?? []) as unknown as FanEditRow[];

  // Aggregations
  const uniqueSignedInUsers = new Set(
    events.map((e) => e.user_id).filter((id): id is string => Boolean(id)),
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
  // City table combines /go/ clicks (always geo-tagged when we have a
  // header) with consent-gated fan_edit_events geo. Each row counts
  // once regardless of source — the table is "where did people
  // engage from", not "where did each source see traffic".
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

  // Hydrate top fan_edits with their best-available creator handle
  // (moonbeem_handle from public_creators where the FK resolves).
  const creatorIdsForTop = Array.from(
    new Set(
      topFanEdits
        .map((fe) => fe.creator_id)
        .filter((id): id is string => Boolean(id)),
    ),
  );
  const handleByCreatorId = new Map<string, string>();
  if (creatorIdsForTop.length > 0) {
    const { data: creators } = await supabase
      .from("public_creators")
      .select("id, moonbeem_handle")
      .in("id", creatorIdsForTop);
    for (const c of creators ?? []) {
      handleByCreatorId.set(c.id as string, c.moonbeem_handle as string);
    }
  }

  // Top creators — aggregate view_count across active fan_edits per creator.
  const creatorAggMap = new Map<
    string,
    { handle: string; view_count: number; fan_edit_count: number }
  >();
  for (const r of allEditsForCreatorsRes.data ?? []) {
    const cid = r.creator_id as string | null;
    if (!cid) continue;
    const handle =
      handleByCreatorId.get(cid) ??
      (r.creator_handle_displayed as string | null) ??
      "anon";
    const existing = creatorAggMap.get(cid);
    if (existing) {
      existing.view_count += (r.view_count as number | null) ?? 0;
      existing.fan_edit_count += 1;
    } else {
      creatorAggMap.set(cid, {
        handle,
        view_count: (r.view_count as number | null) ?? 0,
        fan_edit_count: 1,
      });
    }
  }
  // Fill in any missing handles for top-creators with a one-pass
  // public_creators lookup for creator_ids not already covered.
  const allCreatorIds = Array.from(creatorAggMap.keys());
  const missingHandleIds = allCreatorIds.filter(
    (id) => !handleByCreatorId.has(id) && creatorAggMap.get(id)?.handle === "anon",
  );
  if (missingHandleIds.length > 0) {
    const { data: more } = await supabase
      .from("public_creators")
      .select("id, moonbeem_handle")
      .in("id", missingHandleIds);
    for (const c of more ?? []) {
      const cid = c.id as string;
      const agg = creatorAggMap.get(cid);
      if (agg) agg.handle = (c.moonbeem_handle as string) ?? agg.handle;
    }
  }
  const topCreators: CreatorAgg[] = Array.from(creatorAggMap.entries())
    .map(([creator_id, v]) => ({ creator_id, ...v }))
    .sort((a, b) => b.view_count - a.view_count)
    .slice(0, 10);

  return (
    <div className="min-h-screen bg-[radial-gradient(ellipse_at_top,_#1a0f3a_0%,_#0a0a14_60%)] px-6 py-12 text-moonbeem-ink">
      <div className="mx-auto max-w-6xl flex flex-col gap-10">
        {/* Header strip */}
        <div className="flex items-baseline justify-between gap-4 flex-wrap">
          <div className="flex flex-col gap-1">
            <span className="font-wordmark text-heading-md text-moonbeem-pink">
              moonbeem.
            </span>
            <h1 className="font-wordmark text-display-lg text-moonbeem-ink m-0">
              Dashboard
            </h1>
            <p className="text-body text-moonbeem-ink-muted m-0">
              Platform-wide · {windowLabel(win)}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Link
              href="/admin"
              className="text-body-sm text-moonbeem-ink-muted hover:text-moonbeem-pink"
            >
              ← Admin ops
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
                href={`/admin/dashboard?window=${w}`}
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
            value={(clicks.length).toLocaleString()}
            label="/go/ clicks (humans)"
          />
          <HeroNumber
            value={(titlesCountRes.count ?? 0).toLocaleString()}
            label="Active titles"
          />
          <HeroNumber
            value={(fanEditsCountRes.count ?? 0).toLocaleString()}
            label="Active fan edits"
          />
          <HeroNumber
            value={(openRequestsCountRes.count ?? 0).toLocaleString()}
            label="Open title requests"
          />
        </section>

        {/* Time-series chart */}
        <section className="flex flex-col gap-3">
          <h2 className="text-display-sm m-0">Engagement over time</h2>
          <p className="text-body-sm text-moonbeem-ink-muted m-0">
            Fan-edit modal events ·{" "}
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
            /go/ click + consent-gated event origins ·{" "}
            {totalGeoEvents.toLocaleString()} geo-tagged event
            {totalGeoEvents === 1 ? "" : "s"} in window
          </p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="md:col-span-2 rounded-2xl border border-white/10 bg-white/[0.02] p-4">
              <UsStateChoropleth data={stateData} height={360} />
            </div>
            <div className="flex flex-col">
              <DataTable<(typeof cityBreakdown)[number]>
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
                rows={cityBreakdown.slice(0, 10)}
                rowKey={(r) =>
                  `${r.country_code ?? ""}|${r.region_code ?? ""}|${r.city}`
                }
                emptyMessage="No location data available for this window."
              />
            </div>
          </div>
        </section>

        {/* Top performers */}
        <section className="flex flex-col gap-3">
          <h2 className="text-display-sm m-0">Top performers</h2>
          <p className="text-body-sm text-moonbeem-ink-muted m-0">
            Lifetime view counts across all fan edits. Not affected by
            the time window above.
          </p>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="flex flex-col gap-2">
              <h3 className="text-body-sm font-medium text-moonbeem-ink-muted m-0">
                Top fan edits
              </h3>
              <DataTable<FanEditRow>
                columns={getTopFanEditColumns(handleByCreatorId)}
                rows={topFanEdits}
                rowKey={(r) => r.id}
              />
            </div>
            <div className="flex flex-col gap-2">
              <h3 className="text-body-sm font-medium text-moonbeem-ink-muted m-0">
                Top creators
              </h3>
              <DataTable<CreatorAgg>
                columns={[
                  {
                    key: "handle",
                    label: "Creator",
                    render: (r) => (
                      <Link
                        href={`/c/${r.handle}`}
                        className="text-moonbeem-pink hover:opacity-90"
                      >
                        @{r.handle}
                      </Link>
                    ),
                  },
                  {
                    key: "fan_edit_count",
                    label: "Edits",
                    align: "right",
                    render: (r) => r.fan_edit_count.toLocaleString(),
                  },
                  {
                    key: "view_count",
                    label: "Views",
                    align: "right",
                    render: (r) => r.view_count.toLocaleString(),
                  },
                ]}
                rows={topCreators}
                rowKey={(r) => r.creator_id}
              />
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function getTopFanEditColumns(
  handleByCreatorId: Map<string, string>,
): Column<FanEditRow>[] {
  return [
    {
      key: "title",
      label: "Title",
      render: (r) => {
        const title = r.titles?.title ?? "(unknown)";
        const slug = r.titles?.slug;
        if (!slug) return <span>{title}</span>;
        return (
          <Link
            href={`/admin/titles/${slug}?tab=analytics`}
            className="text-moonbeem-ink hover:text-moonbeem-pink truncate block max-w-[280px]"
          >
            {title}
          </Link>
        );
      },
    },
    {
      key: "creator",
      label: "Creator",
      render: (r) => {
        const handle =
          (r.creator_id && handleByCreatorId.get(r.creator_id)) ||
          r.creator_handle_displayed ||
          "anon";
        return (
          <span className="text-moonbeem-ink-muted text-body-sm">
            @{handle}
          </span>
        );
      },
    },
    {
      key: "platform",
      label: "Views",
      align: "right",
      render: (r) => (r.view_count ?? 0).toLocaleString(),
    },
  ];
}
