// /admin/fan-edits/[id] — per-fan-edit detail page.
//
// Three sections:
//   1. Header — fan_edit identity (title, creator, thumbnail, link
//      out to the public title page + the actual platform URL).
//   2. Stats summary — modal open/close/click counts, avg duration,
//      unique signed-in users. Mirrors the stats RPC at
//      /api/admin/fan-edits/[id]/stats but inline since this page
//      already touches the events table.
//   3. Geo widget — top 10 countries + top 10 cities, time-window
//      toggle (24h / 7d / 30d / all-time). Counts geo-tagged events
//      only; the share of consenting-vs-non-consenting visitors is
//      surfaced in the summary.
//
// Time window is a URL search param. Clicking a window button is a
// full page navigation — acceptable for an admin-only low-volume
// surface, and keeps the page a pure server component.
//
// Queries use the service-role client. RLS-aware structuring: when
// partner-facing reuse arrives, the same shape works with a partner_id
// filter prepended.

import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { requireSuperAdminOr404 } from "@/lib/dal";
import { createServiceRoleClient } from "@/lib/supabase/service";

export const metadata: Metadata = {
  title: "Fan edit detail · Moonbeem admin",
  robots: { index: false, follow: false },
};

type WindowKey = "24h" | "7d" | "30d" | "all";
const VALID_WINDOWS: WindowKey[] = ["24h", "7d", "30d", "all"];

function parseWindow(raw: string | string[] | undefined): WindowKey {
  if (typeof raw === "string" && (VALID_WINDOWS as string[]).includes(raw)) {
    return raw as WindowKey;
  }
  return "7d";
}

function windowToCutoffIso(w: WindowKey): string | null {
  if (w === "all") return null;
  const ms =
    w === "24h" ? 24 * 60 * 60 * 1000
    : w === "7d" ? 7 * 24 * 60 * 60 * 1000
    : 30 * 24 * 60 * 60 * 1000;
  return new Date(Date.now() - ms).toISOString();
}

function windowLabel(w: WindowKey): string {
  if (w === "24h") return "Last 24 hours";
  if (w === "7d") return "Last 7 days";
  if (w === "30d") return "Last 30 days";
  return "All time";
}

type EventRow = {
  event_type: string;
  duration_ms: number | null;
  user_id: string | null;
  country_code: string | null;
  region_code: string | null;
  city: string | null;
  created_at: string;
};

type Stats = {
  open_count: number;
  close_count: number;
  click_count: number;
  avg_duration_ms: number | null;
  unique_signed_in_users: number;
  total_events: number;
  geo_tagged_events: number;
};

function computeStats(rows: EventRow[]): Stats {
  let openCount = 0;
  let closeCount = 0;
  let clickCount = 0;
  let durationTotal = 0;
  let durationSamples = 0;
  let geoTagged = 0;
  const signedInUsers = new Set<string>();
  for (const r of rows) {
    if (r.event_type === "modal_open") openCount += 1;
    else if (r.event_type === "modal_close") {
      closeCount += 1;
      if (typeof r.duration_ms === "number") {
        durationTotal += r.duration_ms;
        durationSamples += 1;
      }
    } else if (r.event_type === "view_on_platform_click") {
      clickCount += 1;
    }
    if (r.user_id) signedInUsers.add(r.user_id);
    if (r.country_code) geoTagged += 1;
  }
  return {
    open_count: openCount,
    close_count: closeCount,
    click_count: clickCount,
    avg_duration_ms: durationSamples > 0
      ? Math.round(durationTotal / durationSamples)
      : null,
    unique_signed_in_users: signedInUsers.size,
    total_events: rows.length,
    geo_tagged_events: geoTagged,
  };
}

type CountryAgg = { country_code: string; count: number; percent: number };
type CityAgg = {
  city: string;
  region_code: string | null;
  country_code: string;
  count: number;
  percent: number;
};

function topCountries(rows: EventRow[]): CountryAgg[] {
  const counts = new Map<string, number>();
  let total = 0;
  for (const r of rows) {
    if (!r.country_code) continue;
    counts.set(r.country_code, (counts.get(r.country_code) ?? 0) + 1);
    total += 1;
  }
  if (total === 0) return [];
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([country_code, count]) => ({
      country_code,
      count,
      percent: Math.round((count / total) * 1000) / 10,
    }));
}

function topCities(rows: EventRow[]): CityAgg[] {
  const counts = new Map<string, { city: string; region_code: string | null; country_code: string; count: number }>();
  let total = 0;
  for (const r of rows) {
    if (!r.city || !r.country_code) continue;
    const key = `${r.country_code}|${r.region_code ?? ""}|${r.city}`;
    const existing = counts.get(key);
    if (existing) existing.count += 1;
    else counts.set(key, {
      city: r.city,
      region_code: r.region_code,
      country_code: r.country_code,
      count: 1,
    });
    total += 1;
  }
  if (total === 0) return [];
  return Array.from(counts.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, 10)
    .map((c) => ({
      ...c,
      percent: Math.round((c.count / total) * 1000) / 10,
    }));
}

function fmtMs(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${ms}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const min = Math.floor(sec / 60);
  const remSec = Math.round(sec - min * 60);
  return `${min}m ${remSec}s`;
}

type PageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ window?: string | string[] }>;
};

export default async function AdminFanEditDetailPage(props: PageProps) {
  await requireSuperAdminOr404();

  const { id } = await props.params;
  const sp = await props.searchParams;
  const window = parseWindow(sp.window);
  const cutoff = windowToCutoffIso(window);

  const supabase = createServiceRoleClient();

  // Header: fan_edit + title + creator handle.
  const { data: fanEdit } = await supabase
    .from("fan_edits")
    .select(
      "id, title_id, creator_id, creator_handle_displayed, platform, embed_url, caption, thumbnail_url, view_count, created_at",
    )
    .eq("id", id)
    .maybeSingle();
  if (!fanEdit) notFound();

  const [titleRes, creatorRes, eventsRes] = await Promise.all([
    supabase
      .from("titles")
      .select("title, slug")
      .eq("id", fanEdit.title_id as string)
      .maybeSingle(),
    fanEdit.creator_id
      ? supabase
          .from("public_creators")
          .select("moonbeem_handle")
          .eq("id", fanEdit.creator_id as string)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    (() => {
      let q = supabase
        .from("fan_edit_events")
        .select("event_type, duration_ms, user_id, country_code, region_code, city, created_at")
        .eq("fan_edit_id", id);
      if (cutoff) q = q.gte("created_at", cutoff);
      return q;
    })(),
  ]);

  const titleName = (titleRes.data?.title as string) ?? "(unknown title)";
  const titleSlug = (titleRes.data?.slug as string) ?? null;
  const creatorHandle =
    (creatorRes.data?.moonbeem_handle as string) ??
    (fanEdit.creator_handle_displayed as string) ??
    "anon";

  const events = (eventsRes.data ?? []) as EventRow[];
  const stats = computeStats(events);
  const countries = topCountries(events);
  const cities = topCities(events);

  return (
    <div className="min-h-screen bg-moonbeem-black px-6 py-12 text-moonbeem-ink">
      <div className="mx-auto flex max-w-4xl flex-col gap-10">
        {/* Top breadcrumb back to admin */}
        <div className="flex items-baseline justify-between gap-4">
          <h1 className="font-wordmark text-display-md text-moonbeem-pink m-0">
            Fan edit detail
          </h1>
          <Link
            href="/admin"
            className="text-body-sm text-moonbeem-ink-muted hover:text-moonbeem-pink"
          >
            ← Back to admin
          </Link>
        </div>

        {/* Header section */}
        <section className="flex flex-col gap-4 rounded-2xl border border-white/10 bg-white/[0.02] p-5 md:flex-row">
          <div className="h-[120px] w-[80px] shrink-0 overflow-hidden rounded-md bg-white/[0.03]">
            {fanEdit.thumbnail_url ? (
              <Image
                src={fanEdit.thumbnail_url as string}
                alt={`${titleName} thumbnail`}
                width={80}
                height={120}
                className="h-full w-full object-cover"
                unoptimized
              />
            ) : null}
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <div className="text-body-lg font-semibold text-moonbeem-ink">
              {titleName}
            </div>
            <div className="text-body-sm text-moonbeem-ink-muted">
              <span className="text-moonbeem-pink">@{creatorHandle}</span>
              <span className="mx-2">·</span>
              <span>{fanEdit.platform as string}</span>
              <span className="mx-2">·</span>
              <span className="tabular-nums">
                {(fanEdit.view_count as number)?.toLocaleString() ?? 0} platform views
              </span>
            </div>
            {fanEdit.caption && (
              <p className="text-body-sm text-moonbeem-ink-muted line-clamp-3 m-0">
                {fanEdit.caption as string}
              </p>
            )}
            <div className="flex flex-wrap gap-3 mt-2 text-caption">
              {titleSlug && (
                <Link
                  href={`/t/${titleSlug}`}
                  className="rounded-md border border-white/10 px-3 py-1 text-moonbeem-ink-muted hover:border-moonbeem-pink hover:text-moonbeem-pink"
                >
                  Public title page →
                </Link>
              )}
              <a
                href={fanEdit.embed_url as string}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-md border border-white/10 px-3 py-1 text-moonbeem-ink-muted hover:border-moonbeem-pink hover:text-moonbeem-pink"
              >
                Open on platform ↗
              </a>
            </div>
          </div>
        </section>

        {/* Window toggle */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-body-sm text-moonbeem-ink-muted mr-2">Window:</span>
          {VALID_WINDOWS.map((w) => {
            const active = w === window;
            return (
              <Link
                key={w}
                href={`/admin/fan-edits/${id}?window=${w}`}
                className={`rounded-md border px-3 py-1.5 text-body-sm transition-colors ${
                  active
                    ? "border-moonbeem-pink bg-moonbeem-pink/10 text-moonbeem-pink"
                    : "border-white/10 text-moonbeem-ink-muted hover:border-moonbeem-pink hover:text-moonbeem-pink"
                }`}
              >
                {windowLabel(w)}
              </Link>
            );
          })}
        </div>

        {/* Stats summary */}
        <section className="flex flex-col gap-3">
          <h2 className="text-display-sm m-0">Stats</h2>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatTile label="Modal opens" value={stats.open_count.toLocaleString()} />
            <StatTile label="Modal closes" value={stats.close_count.toLocaleString()} />
            <StatTile label="Platform clicks" value={stats.click_count.toLocaleString()} />
            <StatTile label="Avg open duration" value={fmtMs(stats.avg_duration_ms)} />
            <StatTile label="Total events" value={stats.total_events.toLocaleString()} />
            <StatTile label="Signed-in users" value={stats.unique_signed_in_users.toLocaleString()} />
            <StatTile
              label="Geo-tagged events"
              value={
                stats.total_events > 0
                  ? `${stats.geo_tagged_events.toLocaleString()} (${Math.round(
                      (stats.geo_tagged_events / stats.total_events) * 100,
                    )}%)`
                  : "0"
              }
            />
          </div>
        </section>

        {/* Geo widget */}
        <section className="flex flex-col gap-3">
          <h2 className="text-display-sm m-0">Geo</h2>
          {stats.geo_tagged_events === 0 ? (
            <p className="text-body text-moonbeem-ink-muted">
              No geo-tagged events in this window. Geo is captured only when
              visitors grant analytics consent.
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
              <div className="flex flex-col gap-2">
                <h3 className="text-body-sm font-semibold text-moonbeem-ink m-0">
                  Top countries ({countries.length})
                </h3>
                <ul className="flex flex-col divide-y divide-white/5 rounded-md border border-white/10 bg-white/[0.02]">
                  {countries.map((c) => (
                    <li
                      key={c.country_code}
                      className="flex items-center justify-between gap-3 px-3 py-2"
                    >
                      <span className="font-mono text-body-sm text-moonbeem-ink">
                        {c.country_code}
                      </span>
                      <span className="text-body-sm text-moonbeem-ink-muted tabular-nums">
                        {c.count.toLocaleString()} · {c.percent}%
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="flex flex-col gap-2">
                <h3 className="text-body-sm font-semibold text-moonbeem-ink m-0">
                  Top cities ({cities.length})
                </h3>
                <ul className="flex flex-col divide-y divide-white/5 rounded-md border border-white/10 bg-white/[0.02]">
                  {cities.map((c, i) => (
                    <li
                      key={`${c.country_code}-${c.region_code ?? ""}-${c.city}-${i}`}
                      className="flex items-center justify-between gap-3 px-3 py-2"
                    >
                      <span className="text-body-sm text-moonbeem-ink truncate">
                        {c.city}
                        <span className="ml-2 text-moonbeem-ink-subtle font-mono text-caption">
                          {c.region_code ? `${c.region_code}, ` : ""}{c.country_code}
                        </span>
                      </span>
                      <span className="text-body-sm text-moonbeem-ink-muted tabular-nums whitespace-nowrap">
                        {c.count.toLocaleString()} · {c.percent}%
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-white/10 bg-white/[0.02] p-3">
      <div className="text-caption text-moonbeem-ink-subtle">{label}</div>
      <div className="mt-1 text-body-lg font-semibold text-moonbeem-ink tabular-nums">
        {value}
      </div>
    </div>
  );
}
