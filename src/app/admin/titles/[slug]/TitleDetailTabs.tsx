"use client";

import Image from "next/image";
import Link from "next/link";
import { useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import FanEditsUploadCard from "@/components/admin/FanEditsUploadCard";
import UploadClient from "./upload/UploadClient";
import DiscoverTab from "./DiscoverTab";
import HeroNumber from "@/components/dashboard/HeroNumber";
import TimeSeriesChart from "@/components/dashboard/TimeSeriesChart";
import UsStateChoropleth from "@/components/dashboard/UsStateChoropleth";
import DataTable, { type Column } from "@/components/dashboard/DataTable";
import ConfirmModal from "@/components/ui/ConfirmModal";
import PosterEditor from "@/components/PosterEditor";
import {
  TIME_WINDOWS,
  windowLabel,
  windowShortLabel,
  type TimeWindow,
  type CityCount,
} from "@/lib/dashboard/queries";

export type FanEditRow = {
  id: string;
  platform: string;
  embed_url: string | null;
  caption: string | null;
  view_count: number;
  like_count: number;
  posted_at: string | null;
  thumbnail_url: string | null;
  // creator_handle: best display label (moonbeem if claimed, else
  // displayed handle from import).
  creator_handle: string | null;
  // moonbeem_handle: when present, this fan_edit's creator_id
  // resolves to a real moonbeem profile we can link to /c/<handle>.
  moonbeem_handle: string | null;
  deleted_at: string | null;
  created_at: string;
};

export type ClipRow = {
  id: string;
  file_url: string | null;
  thumbnail_url: string | null;
  label: string | null;
  content_type: string | null;
  duration_seconds: number | null;
  file_size_bytes: number | null;
  display_order: number;
  deleted_at: string | null;
  created_at: string;
};

export type StillRow = {
  id: string;
  file_url: string | null;
  thumbnail_url: string | null;
  alt_text: string | null;
  content_type: string | null;
  file_size_bytes: number | null;
  width: number | null;
  height: number | null;
  display_order: number;
  deleted_at: string | null;
  created_at: string;
};

type Tab =
  | "fan-edits"
  | "clips"
  | "stills"
  | "discover"
  | "analytics"
  | "upload"
  | "settings";

type PartnerOption = { id: string; slug: string; name: string };

export type AnalyticsFanEditRow = {
  id: string;
  platform: string;
  caption: string | null;
  thumbnail_url: string | null;
  view_count: number;
  modal_opens: number;
  platform_clicks: number;
  creator_handle: string;
};

export type AnalyticsData = {
  events: number;
  uniqueSignedInUsers: number;
  clicks: number;
  totalSocialViews: number;
  fanEditsCount: number;
  openRequests: number;
  timeSeries: { date: string; value: number }[];
  /** Plain object form of state code → click count (Map doesn't serialize). */
  stateData: Record<string, number>;
  cityBreakdown: CityCount[];
  totalGeoEvents: number;
  fanEditsComparison: AnalyticsFanEditRow[];
};

export type TitleMetadata = {
  synopsis: string | null;
  year: number | null;
  runtime_min: number | null;
  director: string | null;
  starring_csv: string | null;
};

type Props = {
  titleId: string;
  titleSlug: string;
  titleName: string;
  isActive: boolean;
  isPublic: boolean;
  partnerId: string | null;
  partnerName: string | null;
  partnerSlug: string | null;
  hasPartner: boolean;
  posterUrl: string | null;
  metadata: TitleMetadata;
  allPartners: PartnerOption[];
  fanEdits: FanEditRow[];
  clips: ClipRow[];
  stills: StillRow[];
  activeTab: Tab;
  activeWindow: TimeWindow;
  analytics: AnalyticsData | null;
};

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "fan-edits", label: "Fan edits" },
  { id: "clips", label: "Clips" },
  { id: "stills", label: "Stills" },
  { id: "discover", label: "Discover" },
  { id: "analytics", label: "Analytics" },
  { id: "upload", label: "Upload" },
  { id: "settings", label: "Settings" },
];

function formatBytes(n: number | null): string {
  if (n === null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatDuration(s: number | null): string {
  if (s === null || !Number.isFinite(s)) return "—";
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}m ${r.toFixed(0)}s`;
}

function formatNum(n: number): string {
  return n.toLocaleString();
}

function StatusPill({
  on,
  label,
  toneOn = "pink",
}: {
  on: boolean;
  label: string;
  toneOn?: "pink" | "emerald" | "violet";
}) {
  if (on) {
    const cls =
      toneOn === "emerald"
        ? "bg-emerald-500/15 text-emerald-300"
        : toneOn === "violet"
          ? "bg-moonbeem-violet/20 text-moonbeem-violet-soft"
          : "bg-moonbeem-pink/15 text-moonbeem-pink";
    return (
      <span className={`rounded-full px-2.5 py-0.5 text-caption font-medium ${cls}`}>
        {label}
      </span>
    );
  }
  return (
    <span className="rounded-full bg-white/5 px-2.5 py-0.5 text-caption text-moonbeem-ink-subtle">
      {label} off
    </span>
  );
}

export default function TitleDetailTabs(props: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [tab, setTab] = useState<Tab>(props.activeTab);

  function selectTab(next: Tab) {
    setTab(next);
    const sp = new URLSearchParams(searchParams.toString());
    if (next === "fan-edits") sp.delete("tab");
    else sp.set("tab", next);
    const qs = sp.toString();
    router.replace(`/admin/titles/${props.titleSlug}${qs ? `?${qs}` : ""}`, {
      scroll: false,
    });
  }

  return (
    <div className="min-h-screen px-6 py-12">
      <div className="mx-auto max-w-6xl">
        <div className="flex items-center justify-between">
          <Link
            href="/admin"
            className="text-body-sm text-moonbeem-ink-muted hover:text-moonbeem-pink"
          >
            ← Admin
          </Link>
          <span className="text-body-sm text-moonbeem-ink-subtle">
            Title detail
          </span>
        </div>

        <div className="mt-8 flex flex-col gap-3">
          <h1 className="font-wordmark text-display-md md:text-display-lg text-moonbeem-ink m-0">
            {props.titleName}
          </h1>
          <div className="flex flex-wrap items-center gap-3 text-body-sm text-moonbeem-ink-muted">
            <span className="font-mono text-caption text-moonbeem-ink-subtle">
              /t/{props.titleSlug}
            </span>
            {props.partnerSlug ? (
              <Link
                href={`/p/${props.partnerSlug}`}
                className="hover:text-moonbeem-pink"
              >
                Partner: {props.partnerName ?? props.partnerSlug}
              </Link>
            ) : (
              <span className="text-moonbeem-ink-subtle">No partner</span>
            )}
            <StatusPill
              on={props.isActive}
              label="Active"
              toneOn="emerald"
            />
            <StatusPill on={props.isPublic} label="Public" toneOn="violet" />
          </div>
        </div>

        <div className="mt-8 border-b border-white/10">
          <nav className="flex gap-6">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => selectTab(t.id)}
                className={`-mb-px border-b-2 px-1 py-3 text-body-sm font-medium transition-colors ${
                  tab === t.id
                    ? "border-moonbeem-pink text-moonbeem-pink"
                    : "border-transparent text-moonbeem-ink-muted hover:text-moonbeem-ink"
                }`}
              >
                {t.label}
                {t.id === "fan-edits" && (
                  <span className="ml-2 rounded-full bg-white/10 px-1.5 text-caption tabular-nums text-moonbeem-ink-subtle">
                    {props.fanEdits.filter((e) => !e.deleted_at).length}
                  </span>
                )}
                {t.id === "clips" && (
                  <span className="ml-2 rounded-full bg-white/10 px-1.5 text-caption tabular-nums text-moonbeem-ink-subtle">
                    {props.clips.filter((c) => !c.deleted_at).length}
                  </span>
                )}
                {t.id === "stills" && (
                  <span className="ml-2 rounded-full bg-white/10 px-1.5 text-caption tabular-nums text-moonbeem-ink-subtle">
                    {props.stills.filter((s) => !s.deleted_at).length}
                  </span>
                )}
              </button>
            ))}
          </nav>
        </div>

        <div className="mt-8">
          {tab === "fan-edits" && (
            <FanEditsList rows={props.fanEdits} titleSlug={props.titleSlug} />
          )}
          {tab === "clips" && (
            <ClipsList rows={props.clips} titleSlug={props.titleSlug} />
          )}
          {tab === "stills" && (
            <StillsList rows={props.stills} titleSlug={props.titleSlug} />
          )}
          {tab === "discover" && (
            <DiscoverTab
              titleSlug={props.titleSlug}
              titleName={props.titleName}
            />
          )}
          {tab === "analytics" && (
            <AnalyticsTab
              titleSlug={props.titleSlug}
              activeWindow={props.activeWindow}
              data={props.analytics}
            />
          )}
          {tab === "upload" && (
            <UploadTab
              titleId={props.titleId}
              titleName={props.titleName}
              titleSlug={props.titleSlug}
            />
          )}
          {tab === "settings" && (
            <SettingsTab
              titleId={props.titleId}
              slug={props.titleSlug}
              titleName={props.titleName}
              initialPosterUrl={props.posterUrl}
              initialMetadata={props.metadata}
              initialIsActive={props.isActive}
              initialIsPublic={props.isPublic}
              initialPartnerId={props.partnerId}
              initialPartnerName={props.partnerName}
              initialPartnerSlug={props.partnerSlug}
              allPartners={props.allPartners}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function FanEditsList({
  rows,
  titleSlug,
}: {
  rows: FanEditRow[];
  titleSlug: string;
}) {
  const [edits, setEdits] = useState(rows);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errorId, setErrorId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  async function deleteEdit(id: string) {
    const ok = window.confirm(
      "Soft-delete this fan edit? It will disappear from the public title page immediately. (Restorable from SQL — not undoable in the UI today.)",
    );
    if (!ok) return;
    setBusyId(id);
    setErrorId(null);
    setErrorMsg(null);
    try {
      const res = await fetch(`/api/admin/fan-edits/${id}/delete`, {
        method: "POST",
      });
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !json.ok) {
        setErrorId(id);
        setErrorMsg(json.error ?? `request failed (${res.status})`);
        return;
      }
      setEdits((cur) =>
        cur.map((e) =>
          e.id === id ? { ...e, deleted_at: new Date().toISOString() } : e,
        ),
      );
    } catch (err) {
      setErrorId(id);
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  if (edits.length === 0) {
    return (
      <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-8 text-center">
        <p className="text-body-sm text-moonbeem-ink-muted">
          No fan edits attributed to this title yet. Use the Upload tab to
          import a CSV.
        </p>
      </div>
    );
  }

  const live = edits.filter((e) => !e.deleted_at);
  const deleted = edits.filter((e) => !!e.deleted_at);

  return (
    <div className="flex flex-col gap-6">
      <div className="rounded-2xl border border-white/10 bg-white/[0.02] overflow-hidden">
        <table className="w-full text-body-sm">
          <thead className="border-b border-white/5 text-caption uppercase tracking-wider text-moonbeem-ink-subtle">
            <tr>
              <th className="px-4 py-3 text-left">Edit</th>
              <th className="px-4 py-3 text-left">Creator</th>
              <th className="px-4 py-3 text-left">Platform</th>
              <th className="px-4 py-3 text-right">Views</th>
              <th className="px-4 py-3 text-left">Imported</th>
              <th className="px-4 py-3 text-right"></th>
            </tr>
          </thead>
          <tbody>
            {live.map((e) => (
              <tr
                key={e.id}
                className="border-b border-white/5 last:border-b-0"
              >
                <td className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    <div className="relative h-12 w-12 shrink-0 overflow-hidden rounded-md bg-moonbeem-navy/40">
                      {e.thumbnail_url ? (
                        <Image
                          src={e.thumbnail_url}
                          alt=""
                          fill
                          sizes="48px"
                          unoptimized
                          className="object-cover"
                        />
                      ) : null}
                    </div>
                    {e.embed_url ? (
                      <a
                        href={e.embed_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="truncate text-moonbeem-ink hover:text-moonbeem-pink max-w-xs"
                      >
                        {(e.caption ?? e.embed_url).slice(0, 80)}
                      </a>
                    ) : (
                      <span className="text-moonbeem-ink-subtle">
                        (no embed)
                      </span>
                    )}
                  </div>
                </td>
                <td className="px-4 py-3">
                  {e.moonbeem_handle ? (
                    <Link
                      href={`/c/${e.moonbeem_handle}`}
                      className="text-moonbeem-ink hover:text-moonbeem-pink"
                    >
                      @{e.moonbeem_handle}
                    </Link>
                  ) : e.creator_handle ? (
                    <span className="text-moonbeem-ink-muted">
                      @{e.creator_handle}
                    </span>
                  ) : (
                    <span className="text-moonbeem-ink-subtle">—</span>
                  )}
                </td>
                <td className="px-4 py-3 text-moonbeem-ink-muted capitalize">
                  {e.platform}
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-moonbeem-ink">
                  {formatNum(e.view_count)}
                </td>
                <td className="px-4 py-3 text-moonbeem-ink-subtle text-caption">
                  {new Date(e.created_at).toLocaleDateString()}
                </td>
                <td className="px-4 py-3 text-right">
                  <button
                    type="button"
                    onClick={() => deleteEdit(e.id)}
                    disabled={busyId === e.id}
                    className="rounded-md border border-moonbeem-magenta/30 px-3 py-1 text-caption text-moonbeem-magenta hover:bg-moonbeem-magenta/10 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {busyId === e.id ? "Deleting…" : "Delete"}
                  </button>
                  {errorId === e.id && errorMsg && (
                    <p className="mt-1 text-caption text-moonbeem-magenta">
                      {errorMsg}
                    </p>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {deleted.length > 0 && (
        <details className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
          <summary className="cursor-pointer text-body-sm text-moonbeem-ink-muted">
            Soft-deleted ({deleted.length})
          </summary>
          <ul className="mt-3 flex flex-col gap-2 text-caption text-moonbeem-ink-subtle">
            {deleted.map((e) => (
              <li key={e.id} className="flex items-center justify-between gap-3">
                <span className="truncate">
                  {e.creator_handle ? `@${e.creator_handle}` : "(anon)"} ·{" "}
                  {e.platform} · {formatNum(e.view_count)} views
                </span>
                <span className="font-mono">
                  {e.deleted_at &&
                    new Date(e.deleted_at).toLocaleDateString()}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}

      <p className="text-caption text-moonbeem-ink-subtle">
        Public surface: <Link href={`/t/${titleSlug}`} className="hover:text-moonbeem-pink">/t/{titleSlug}</Link>. Soft-deleted edits drop out immediately.
      </p>
    </div>
  );
}

function ClipsList({
  rows,
  titleSlug,
}: {
  rows: ClipRow[];
  titleSlug: string;
}) {
  const [clips, setClips] = useState(rows);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errorId, setErrorId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [pending, setPending] = useState<
    { action: "delete" | "restore"; clip: ClipRow } | null
  >(null);

  async function performAction() {
    if (!pending) return;
    const { action, clip } = pending;
    const id = clip.id;
    setBusyId(id);
    setErrorId(null);
    setErrorMsg(null);
    try {
      const res = await fetch(`/api/admin/clips/${id}/${action}`, {
        method: "POST",
      });
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !json.ok) {
        setErrorId(id);
        setErrorMsg(json.error ?? `request failed (${res.status})`);
        return;
      }
      setClips((cur) =>
        cur.map((c) =>
          c.id === id
            ? {
                ...c,
                deleted_at:
                  action === "delete" ? new Date().toISOString() : null,
              }
            : c,
        ),
      );
      setPending(null);
    } catch (err) {
      setErrorId(id);
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  if (clips.length === 0) {
    return (
      <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-8 text-center">
        <p className="text-body-sm text-moonbeem-ink-muted">
          No clips uploaded for this title yet. Use the Upload tab.
        </p>
      </div>
    );
  }

  const live = clips.filter((c) => !c.deleted_at);
  const deleted = clips.filter((c) => !!c.deleted_at);

  return (
    <div className="flex flex-col gap-6">
      <div className="rounded-2xl border border-white/10 bg-white/[0.02] overflow-hidden">
        <table className="w-full text-body-sm">
          <thead className="border-b border-white/5 text-caption uppercase tracking-wider text-moonbeem-ink-subtle">
            <tr>
              <th className="px-4 py-3 text-left">Clip</th>
              <th className="px-4 py-3 text-left">Type</th>
              <th className="px-4 py-3 text-right">Duration</th>
              <th className="px-4 py-3 text-right">Size</th>
              <th className="px-4 py-3 text-left">Uploaded</th>
              <th className="px-4 py-3 text-right"></th>
            </tr>
          </thead>
          <tbody>
            {live.map((c) => (
              <tr
                key={c.id}
                className="border-b border-white/5 last:border-b-0"
              >
                <td className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    <div className="relative h-12 w-16 shrink-0 overflow-hidden rounded-md bg-moonbeem-navy/40">
                      {c.thumbnail_url ? (
                        <Image
                          src={c.thumbnail_url}
                          alt=""
                          fill
                          sizes="64px"
                          unoptimized
                          className="object-cover"
                        />
                      ) : c.file_url ? (
                        // Browser-rendered poster frame as a stopgap
                        // until the ffmpeg pipeline lands. `#t=0.1`
                        // tells the browser to seek to ~0.1s and
                        // render that frame as the still; preload
                        // metadata is enough to load the byte range
                        // for that frame. Falls back gracefully to
                        // the navy placeholder when the browser/codec
                        // combo doesn't honour the fragment seek.
                        <video
                          src={`${c.file_url}#t=0.1`}
                          preload="metadata"
                          muted
                          playsInline
                          className="absolute inset-0 h-full w-full object-cover"
                        />
                      ) : null}
                    </div>
                    {c.file_url ? (
                      <a
                        href={c.file_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="truncate text-moonbeem-ink hover:text-moonbeem-pink max-w-xs"
                      >
                        {c.label ?? c.file_url.split("/").pop()}
                      </a>
                    ) : (
                      <span className="text-moonbeem-ink-subtle">
                        {c.label ?? "(no file)"}
                      </span>
                    )}
                  </div>
                </td>
                <td className="px-4 py-3 font-mono text-caption text-moonbeem-ink-muted">
                  {c.content_type ?? "—"}
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-moonbeem-ink-muted">
                  {formatDuration(c.duration_seconds)}
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-moonbeem-ink-muted">
                  {formatBytes(c.file_size_bytes)}
                </td>
                <td className="px-4 py-3 text-moonbeem-ink-subtle text-caption">
                  {new Date(c.created_at).toLocaleDateString()}
                </td>
                <td className="px-4 py-3 text-right">
                  <button
                    type="button"
                    onClick={() => setPending({ action: "delete", clip: c })}
                    disabled={busyId === c.id}
                    className="rounded-md border border-moonbeem-magenta/30 px-3 py-1 text-caption text-moonbeem-magenta hover:bg-moonbeem-magenta/10 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {busyId === c.id ? "Deleting…" : "Delete"}
                  </button>
                  {errorId === c.id && errorMsg && (
                    <p className="mt-1 text-caption text-moonbeem-magenta">
                      {errorMsg}
                    </p>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {deleted.length > 0 && (
        <details className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
          <summary className="cursor-pointer text-body-sm text-moonbeem-ink-muted">
            Soft-deleted ({deleted.length})
          </summary>
          <ul className="mt-3 flex flex-col gap-2 text-caption text-moonbeem-ink-subtle">
            {deleted.map((c) => (
              <li
                key={c.id}
                className="flex items-center justify-between gap-3"
              >
                <span className="min-w-0 flex-1 truncate">
                  {c.label ?? c.file_url ?? "(unnamed)"} ·{" "}
                  {formatDuration(c.duration_seconds)} ·{" "}
                  {formatBytes(c.file_size_bytes)}
                </span>
                <span className="font-mono">
                  {c.deleted_at &&
                    new Date(c.deleted_at).toLocaleDateString()}
                </span>
                <button
                  type="button"
                  onClick={() => setPending({ action: "restore", clip: c })}
                  disabled={busyId === c.id}
                  className="rounded-md border border-moonbeem-pink/30 px-2.5 py-0.5 text-caption text-moonbeem-pink hover:bg-moonbeem-pink/10 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {busyId === c.id ? "Restoring…" : "Restore"}
                </button>
              </li>
            ))}
          </ul>
          {errorId && errorMsg && deleted.some((c) => c.id === errorId) && (
            <p className="mt-3 text-caption text-moonbeem-magenta">
              {errorMsg}
            </p>
          )}
        </details>
      )}

      <p className="text-caption text-moonbeem-ink-subtle">
        Public surface:{" "}
        <Link
          href={`/t/${titleSlug}`}
          className="hover:text-moonbeem-pink"
        >
          /t/{titleSlug}
        </Link>
        . Soft-deleted clips drop out immediately. R2 objects are kept
        (purge job TBD).
      </p>

      <ConfirmModal
        isOpen={!!pending}
        title={pending?.action === "restore" ? "Restore clip?" : "Delete this clip?"}
        description={
          pending?.action === "restore"
            ? `Restore "${pending.clip.label ?? "this clip"}"? It will reappear on the public title page immediately.`
            : `Soft-delete "${pending?.clip.label ?? "this clip"}"? It will disappear from the public title page immediately.`
        }
        detail={
          pending?.action === "restore"
            ? "The R2 object was kept after soft-delete, so the file is fully recoverable."
            : "Reversible — open the Soft-deleted block and hit Restore."
        }
        confirmLabel={pending?.action === "restore" ? "Restore" : "Delete"}
        tone={pending?.action === "restore" ? "primary" : "destructive"}
        busy={!!busyId}
        onConfirm={performAction}
        onCancel={() => {
          if (busyId) return;
          setPending(null);
        }}
      />
    </div>
  );
}

function StillsList({
  rows,
  titleSlug,
}: {
  rows: StillRow[];
  titleSlug: string;
}) {
  const [stills, setStills] = useState(rows);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errorId, setErrorId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [pending, setPending] = useState<
    { action: "delete" | "restore"; still: StillRow } | null
  >(null);

  async function performAction() {
    if (!pending) return;
    const { action, still } = pending;
    const id = still.id;
    setBusyId(id);
    setErrorId(null);
    setErrorMsg(null);
    try {
      const res = await fetch(`/api/admin/stills/${id}/${action}`, {
        method: "POST",
      });
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !json.ok) {
        setErrorId(id);
        setErrorMsg(json.error ?? `request failed (${res.status})`);
        return;
      }
      setStills((cur) =>
        cur.map((s) =>
          s.id === id
            ? {
                ...s,
                deleted_at:
                  action === "delete" ? new Date().toISOString() : null,
              }
            : s,
        ),
      );
      setPending(null);
    } catch (err) {
      setErrorId(id);
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  if (stills.length === 0) {
    return (
      <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-8 text-center">
        <p className="text-body-sm text-moonbeem-ink-muted">
          No stills uploaded for this title yet. Use the Upload tab.
        </p>
      </div>
    );
  }

  const live = stills.filter((s) => !s.deleted_at);
  const deleted = stills.filter((s) => !!s.deleted_at);

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4">
        {live.map((s) => (
          <div
            key={s.id}
            className="overflow-hidden rounded-2xl border border-white/10 bg-white/[0.02]"
          >
            <div className="relative aspect-video bg-moonbeem-navy/40">
              {s.file_url ? (
                <Image
                  src={s.file_url}
                  alt={s.alt_text ?? ""}
                  fill
                  sizes="(min-width: 1024px) 25vw, (min-width: 768px) 33vw, 50vw"
                  unoptimized
                  className="object-cover"
                />
              ) : null}
            </div>
            <div className="flex flex-col gap-2 p-3">
              <div className="truncate text-body-sm text-moonbeem-ink">
                {s.alt_text ?? s.file_url?.split("/").pop() ?? "(unnamed)"}
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-moonbeem-ink-subtle">
                {s.width && s.height && (
                  <span className="tabular-nums">
                    {s.width}×{s.height}
                  </span>
                )}
                <span>{formatBytes(s.file_size_bytes)}</span>
                <span>{new Date(s.created_at).toLocaleDateString()}</span>
              </div>
              <div className="mt-1 flex items-center justify-between gap-2">
                {s.file_url ? (
                  <a
                    href={s.file_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-caption text-moonbeem-ink-muted hover:text-moonbeem-pink"
                  >
                    Open →
                  </a>
                ) : (
                  <span />
                )}
                <button
                  type="button"
                  onClick={() => setPending({ action: "delete", still: s })}
                  disabled={busyId === s.id}
                  className="rounded-md border border-moonbeem-magenta/30 px-2.5 py-1 text-caption text-moonbeem-magenta hover:bg-moonbeem-magenta/10 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {busyId === s.id ? "Deleting…" : "Delete"}
                </button>
              </div>
              {errorId === s.id && errorMsg && (
                <p className="text-caption text-moonbeem-magenta">{errorMsg}</p>
              )}
            </div>
          </div>
        ))}
      </div>

      {deleted.length > 0 && (
        <details className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
          <summary className="cursor-pointer text-body-sm text-moonbeem-ink-muted">
            Soft-deleted ({deleted.length})
          </summary>
          <ul className="mt-3 flex flex-col gap-2 text-caption text-moonbeem-ink-subtle">
            {deleted.map((s) => (
              <li
                key={s.id}
                className="flex items-center justify-between gap-3"
              >
                <span className="min-w-0 flex-1 truncate">
                  {s.alt_text ?? s.file_url ?? "(unnamed)"} ·{" "}
                  {formatBytes(s.file_size_bytes)}
                </span>
                <span className="font-mono">
                  {s.deleted_at &&
                    new Date(s.deleted_at).toLocaleDateString()}
                </span>
                <button
                  type="button"
                  onClick={() => setPending({ action: "restore", still: s })}
                  disabled={busyId === s.id}
                  className="rounded-md border border-moonbeem-pink/30 px-2.5 py-0.5 text-caption text-moonbeem-pink hover:bg-moonbeem-pink/10 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {busyId === s.id ? "Restoring…" : "Restore"}
                </button>
              </li>
            ))}
          </ul>
          {errorId && errorMsg && deleted.some((s) => s.id === errorId) && (
            <p className="mt-3 text-caption text-moonbeem-magenta">
              {errorMsg}
            </p>
          )}
        </details>
      )}

      <p className="text-caption text-moonbeem-ink-subtle">
        Public surface:{" "}
        <Link
          href={`/t/${titleSlug}`}
          className="hover:text-moonbeem-pink"
        >
          /t/{titleSlug}
        </Link>
        . Soft-deleted stills drop out immediately. R2 objects are kept
        (purge job TBD).
      </p>

      <ConfirmModal
        isOpen={!!pending}
        title={pending?.action === "restore" ? "Restore still?" : "Delete this still?"}
        description={
          pending?.action === "restore"
            ? `Restore "${pending.still.alt_text ?? "this still"}"? It will reappear on the public title page immediately.`
            : `Soft-delete "${pending?.still.alt_text ?? "this still"}"? It will disappear from the public title page immediately.`
        }
        detail={
          pending?.action === "restore"
            ? "The R2 object was kept after soft-delete, so the image is fully recoverable."
            : "Reversible — open the Soft-deleted block and hit Restore."
        }
        confirmLabel={pending?.action === "restore" ? "Restore" : "Delete"}
        tone={pending?.action === "restore" ? "primary" : "destructive"}
        busy={!!busyId}
        onConfirm={performAction}
        onCancel={() => {
          if (busyId) return;
          setPending(null);
        }}
      />
    </div>
  );
}

function UploadTab({
  titleId,
  titleName,
  titleSlug,
}: {
  titleId: string;
  titleName: string;
  titleSlug: string;
}) {
  return (
    <div className="flex flex-col gap-8">
      <section className="rounded-2xl border border-white/10 bg-white/[0.02] p-6">
        <div className="mb-4 flex items-center gap-3">
          <span className="rounded-full bg-moonbeem-pink/15 px-2.5 py-0.5 text-caption font-medium text-moonbeem-pink">
            Fan edits CSV
          </span>
          <span className="text-caption text-moonbeem-ink-subtle">
            scoped to {titleName}
          </span>
        </div>
        <FanEditsUploadCard titleIdOverride={titleId} />
      </section>

      <section className="rounded-2xl border border-white/10 bg-white/[0.02] p-6">
        <div className="mb-4 flex items-center gap-3">
          <span className="rounded-full bg-moonbeem-violet/20 px-2.5 py-0.5 text-caption font-medium text-moonbeem-violet-soft">
            Clips & stills
          </span>
          <span className="text-caption text-moonbeem-ink-subtle">
            scoped to {titleName}
          </span>
        </div>
        <div className="-mx-6 -mb-6">
          {/* UploadClient renders its own min-h-screen + container; */}
          {/* we let it lay out at full width inside the section card. */}
          <UploadClient
            titleId={titleId}
            titleName={titleName}
            titleSlug={titleSlug}
          />
        </div>
      </section>
    </div>
  );
}

// Bulk-append Instagram episodes to the Watch tab. Paste one URL per line;
// optional "| Label" after the URL. The client splits URL/label; the SERVER
// validates/normalizes the IG URLs, assigns episode numbers (max+1, paste
// order), and inserts. Append-only (no edit/delete UI by design).
type EpisodeAddResult = {
  added: number;
  skipped: Array<{ line: number; url: string; reason: string }>;
  errors: Array<{ line: number; url: string; error: string }>;
};

function EpisodesEditor({
  titleId,
  titleSlug,
}: {
  titleId: string;
  titleSlug: string;
}) {
  const [text, setText] = useState("");
  const [state, setState] = useState<"idle" | "submitting" | "done" | "error">(
    "idle",
  );
  const [result, setResult] = useState<EpisodeAddResult | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [thumbState, setThumbState] = useState<
    "idle" | "running" | "done" | "error"
  >("idle");
  const [thumbResult, setThumbResult] = useState<{
    enriched: number;
    failed: number;
    remaining: number;
  } | null>(null);
  const [thumbError, setThumbError] = useState<string | null>(null);

  // One non-empty line = one episode. URL first; optional label after the FIRST
  // "|" (pipe — unambiguous, neither URLs nor labels normally contain it).
  const items = useMemo(
    () =>
      text
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((line) => {
          const idx = line.indexOf("|");
          const url = (idx === -1 ? line : line.slice(0, idx)).trim();
          const label = idx === -1 ? undefined : line.slice(idx + 1).trim();
          return label ? { url, label } : { url };
        }),
    [text],
  );

  async function submit() {
    if (items.length === 0 || state === "submitting") return;
    setState("submitting");
    setErrorMsg(null);
    setResult(null);
    try {
      const res = await fetch(`/api/titles/${titleId}/episodes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        added?: number;
        skipped?: EpisodeAddResult["skipped"];
        errors?: EpisodeAddResult["errors"];
        error?: string;
      };
      if (!res.ok || !json.ok) {
        setState("error");
        setErrorMsg(json.error ?? `request failed (${res.status})`);
        return;
      }
      setResult({
        added: json.added ?? 0,
        skipped: json.skipped ?? [],
        errors: json.errors ?? [],
      });
      setState("done");
      if ((json.added ?? 0) > 0) setText(""); // clear on a successful add
    } catch (err) {
      setState("error");
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  }

  // Best-effort cover enrichment: auto-derive IG covers, re-host to R2. Capped +
  // re-runnable — click again while remaining > 0.
  async function fetchThumbnails() {
    if (thumbState === "running") return;
    setThumbState("running");
    setThumbError(null);
    try {
      const res = await fetch(`/api/titles/${titleId}/episodes/thumbnails`, {
        method: "POST",
      });
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        enriched?: number;
        failed?: number;
        remaining?: number;
        error?: string;
      };
      if (!res.ok || !json.ok) {
        setThumbState("error");
        setThumbError(json.error ?? `request failed (${res.status})`);
        return;
      }
      setThumbResult({
        enriched: json.enriched ?? 0,
        failed: json.failed ?? 0,
        remaining: json.remaining ?? 0,
      });
      setThumbState("done");
    } catch (err) {
      setThumbState("error");
      setThumbError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <section className="rounded-2xl border border-white/10 bg-white/[0.02] p-6">
      <h2 className="m-0 text-body font-medium text-moonbeem-ink">Episodes</h2>
      <p className="mt-1 text-caption text-moonbeem-ink-subtle">
        Paste Instagram post/reel URLs, one per line — appended to the{" "}
        <code className="font-mono">/t/{titleSlug}</code> Watch tab in paste
        order. Optional label after a <code className="font-mono">|</code> (e.g.{" "}
        <code className="font-mono">
          https://instagram.com/reel/XXXX/ | Opening scene
        </code>
        ); no label → <span className="font-mono">Episode N</span>.
      </p>

      <textarea
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          if (state !== "idle") setState("idle");
        }}
        rows={8}
        placeholder={
          "https://www.instagram.com/reel/XXXXXXXXX/\nhttps://www.instagram.com/p/YYYYYYYYY/ | Behind the scenes"
        }
        className="mt-4 w-full rounded-md border border-white/10 bg-black/30 px-3 py-2 font-mono text-caption text-moonbeem-ink focus:border-moonbeem-pink focus:outline-none"
      />
      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          onClick={submit}
          disabled={items.length === 0 || state === "submitting"}
          className="rounded-md bg-moonbeem-pink px-4 py-2 text-body-sm font-semibold text-moonbeem-navy transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {state === "submitting"
            ? "Adding…"
            : `Add ${items.length} episode${items.length === 1 ? "" : "s"}`}
        </button>
        <span className="text-caption text-moonbeem-ink-subtle">
          {items.length} line{items.length === 1 ? "" : "s"} parsed
        </span>
      </div>

      {result && (
        <div className="mt-3 flex flex-col gap-1">
          <p className="m-0 text-caption text-emerald-300">
            Added {result.added}.
            {result.skipped.length > 0
              ? ` Skipped ${result.skipped.length} already present.`
              : ""}
          </p>
          {result.errors.length > 0 && (
            <div className="text-caption text-moonbeem-magenta">
              <p className="m-0">
                {result.errors.length} line
                {result.errors.length === 1 ? "" : "s"} not added:
              </p>
              <ul className="m-0 mt-1 list-disc pl-5">
                {result.errors.map((e) => (
                  <li key={e.line}>
                    Line {e.line}: {e.error}
                    {e.url ? ` — ${e.url}` : ""}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {result.added > 0 && (
            <Link
              href={`/t/${titleSlug}`}
              className="m-0 w-fit text-caption text-moonbeem-ink-muted hover:text-moonbeem-pink"
            >
              View Watch tab →
            </Link>
          )}
        </div>
      )}
      {errorMsg && (
        <p className="m-0 mt-2 text-caption text-moonbeem-magenta">{errorMsg}</p>
      )}

      {/* Cover thumbnails — best-effort auto-derive from Instagram, re-hosted to
          R2. Decoupled from the add above; re-runnable for any remaining. */}
      <div className="mt-5 border-t border-white/10 pt-4">
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={fetchThumbnails}
            disabled={thumbState === "running"}
            className="rounded-md border border-white/15 bg-white/5 px-3 py-1.5 text-body-sm text-moonbeem-ink transition-colors hover:border-moonbeem-pink hover:text-moonbeem-pink disabled:cursor-not-allowed disabled:opacity-50"
          >
            {thumbState === "running" ? "Fetching covers…" : "Fetch thumbnails"}
          </button>
          <span className="text-caption text-moonbeem-ink-subtle">
            Auto-derives Instagram covers (re-hosted to R2). Failures keep the
            numbered tile; re-run for any remaining.
          </span>
        </div>
        {thumbResult && (
          <p className="m-0 mt-2 text-caption text-emerald-300">
            Enriched {thumbResult.enriched}
            {thumbResult.failed > 0
              ? `, ${thumbResult.failed} failed (kept numbered tile)`
              : ""}
            .
            {thumbResult.remaining > 0
              ? ` ${thumbResult.remaining} remaining — click again to continue.`
              : " All covered."}
          </p>
        )}
        {thumbError && (
          <p className="m-0 mt-2 text-caption text-moonbeem-magenta">
            {thumbError}
          </p>
        )}
      </div>
    </section>
  );
}

// Metadata editor — the 5 rendered About-tab fields. Partial PATCH: each Save
// sends only the changed fields. tagline/overview/genres are intentionally
// absent (dead columns). starring_csv is a comma-separated name list.
function DetailsEditor({
  titleId,
  titleSlug,
  initialMetadata,
}: {
  titleId: string;
  titleSlug: string;
  initialMetadata: TitleMetadata;
}) {
  // Saved = the last server-confirmed values; form = the editable strings.
  const [saved, setSaved] = useState<TitleMetadata>(initialMetadata);
  const [synopsis, setSynopsis] = useState(initialMetadata.synopsis ?? "");
  const [year, setYear] = useState(
    initialMetadata.year != null ? String(initialMetadata.year) : "",
  );
  const [runtime, setRuntime] = useState(
    initialMetadata.runtime_min != null
      ? String(initialMetadata.runtime_min)
      : "",
  );
  const [director, setDirector] = useState(initialMetadata.director ?? "");
  const [starring, setStarring] = useState(initialMetadata.starring_csv ?? "");
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">(
    "idle",
  );
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Build the partial body of ONLY changed fields (PATCH semantics). Empty
  // string → null (clears the field). year/runtime sent as the trimmed string;
  // the route validates + coerces.
  function changedFields(): Record<string, string | number | null> | "invalid" {
    const out: Record<string, string | number | null> = {};
    const synN = synopsis.trim() || null;
    if (synN !== (saved.synopsis ?? null)) out.synopsis = synN;
    const dirN = director.trim() || null;
    if (dirN !== (saved.director ?? null)) out.director = dirN;
    const starN = starring.trim() || null;
    if (starN !== (saved.starring_csv ?? null)) out.starring_csv = starN;

    const yTrim = year.trim();
    const yVal = yTrim === "" ? null : Number(yTrim);
    if (yTrim !== "" && !Number.isInteger(yVal)) return "invalid";
    if ((yVal ?? null) !== (saved.year ?? null)) out.year = yVal;

    const rTrim = runtime.trim();
    const rVal = rTrim === "" ? null : Number(rTrim);
    if (rTrim !== "" && !Number.isInteger(rVal)) return "invalid";
    if ((rVal ?? null) !== (saved.runtime_min ?? null)) out.runtime_min = rVal;

    return out;
  }

  const dirty = (() => {
    const c = changedFields();
    return c === "invalid" ? true : Object.keys(c).length > 0;
  })();

  async function save() {
    const fields = changedFields();
    if (fields === "invalid") {
      setState("error");
      setErrorMsg("Year and runtime must be whole numbers.");
      return;
    }
    if (Object.keys(fields).length === 0) return;
    setState("saving");
    setErrorMsg(null);
    try {
      const res = await fetch(`/api/titles/${titleId}/metadata`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fields),
      });
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        title?: TitleMetadata;
        error?: string;
      };
      if (!res.ok || !json.ok || !json.title) {
        setState("error");
        setErrorMsg(json.error ?? `request failed (${res.status})`);
        return;
      }
      // Settle to server truth (it returns the full row after the partial write).
      const t = json.title;
      setSaved({
        synopsis: t.synopsis,
        year: t.year,
        runtime_min: t.runtime_min,
        director: t.director,
        starring_csv: t.starring_csv,
      });
      setSynopsis(t.synopsis ?? "");
      setYear(t.year != null ? String(t.year) : "");
      setRuntime(t.runtime_min != null ? String(t.runtime_min) : "");
      setDirector(t.director ?? "");
      setStarring(t.starring_csv ?? "");
      setState("saved");
    } catch (err) {
      setState("error");
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  }

  const inputCls =
    "w-full rounded-md border border-white/10 bg-black/30 px-3 py-2 text-body-sm text-moonbeem-ink focus:border-moonbeem-pink focus:outline-none";
  const labelCls = "text-caption text-moonbeem-ink-subtle";
  const onAnyChange = () => {
    if (state !== "idle") setState("idle");
  };

  return (
    <section className="rounded-2xl border border-white/10 bg-white/[0.02] p-6">
      <h2 className="m-0 text-body font-medium text-moonbeem-ink">Details</h2>
      <p className="mt-1 text-caption text-moonbeem-ink-subtle">
        Core metadata shown on the{" "}
        <code className="font-mono">/t/{titleSlug}</code> About tab. Edit any
        field and Save — only changed fields are written.
      </p>

      <div className="mt-5 flex flex-col gap-4">
        <label className="flex flex-col gap-1">
          <span className={labelCls}>Synopsis</span>
          <textarea
            value={synopsis}
            onChange={(e) => {
              setSynopsis(e.target.value);
              onAnyChange();
            }}
            rows={4}
            placeholder="The About-tab description paragraph."
            className={inputCls}
          />
        </label>

        <div className="grid grid-cols-2 gap-4">
          <label className="flex flex-col gap-1">
            <span className={labelCls}>Year</span>
            <input
              type="number"
              inputMode="numeric"
              value={year}
              onChange={(e) => {
                setYear(e.target.value);
                onAnyChange();
              }}
              placeholder="2026"
              className={inputCls}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className={labelCls}>Runtime (minutes)</span>
            <input
              type="number"
              inputMode="numeric"
              value={runtime}
              onChange={(e) => {
                setRuntime(e.target.value);
                onAnyChange();
              }}
              placeholder="12"
              className={inputCls}
            />
          </label>
        </div>

        <label className="flex flex-col gap-1">
          <span className={labelCls}>Director</span>
          <input
            type="text"
            value={director}
            onChange={(e) => {
              setDirector(e.target.value);
              onAnyChange();
            }}
            placeholder="Jane Doe"
            className={inputCls}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className={labelCls}>
            Starring{" "}
            <span className="text-moonbeem-ink-subtle">
              (comma-separated: Name, Name, Name)
            </span>
          </span>
          <input
            type="text"
            value={starring}
            onChange={(e) => {
              setStarring(e.target.value);
              onAnyChange();
            }}
            placeholder="Actor One, Actor Two"
            className={inputCls}
          />
        </label>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={save}
            disabled={!dirty || state === "saving"}
            className="rounded-md bg-moonbeem-pink px-4 py-2 text-body-sm font-semibold text-moonbeem-navy transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {state === "saving" ? "Saving…" : "Save details"}
          </button>
          {state === "saved" && !dirty && (
            <span className="text-caption text-emerald-300">Saved ✓</span>
          )}
        </div>
        {errorMsg && (
          <p className="m-0 text-caption text-moonbeem-magenta">{errorMsg}</p>
        )}
      </div>
    </section>
  );
}

type SettingsState = "idle" | "saving" | "error";

function SettingsTab({
  titleId,
  slug,
  titleName,
  initialPosterUrl,
  initialMetadata,
  initialIsActive,
  initialIsPublic,
  initialPartnerId,
  initialPartnerName,
  initialPartnerSlug,
  allPartners,
}: {
  titleId: string;
  slug: string;
  titleName: string;
  initialPosterUrl: string | null;
  initialMetadata: TitleMetadata;
  initialIsActive: boolean;
  initialIsPublic: boolean;
  initialPartnerId: string | null;
  initialPartnerName: string | null;
  initialPartnerSlug: string | null;
  allPartners: PartnerOption[];
}) {
  const [isActive, setIsActive] = useState(initialIsActive);
  const [isPublic, setIsPublic] = useState(initialIsPublic);
  const [partnerId, setPartnerId] = useState<string | null>(initialPartnerId);
  const [partnerName, setPartnerName] = useState<string | null>(
    initialPartnerName,
  );
  const [partnerSlug, setPartnerSlug] = useState<string | null>(
    initialPartnerSlug,
  );
  const [state, setState] = useState<SettingsState>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerChoice, setPickerChoice] = useState<string>(
    initialPartnerId ?? "",
  );
  const [partnerBusy, setPartnerBusy] = useState(false);

  async function patch(payload: {
    is_active?: boolean;
    is_public?: boolean;
    partner_id?: string | null;
  }) {
    setState("saving");
    setErrorMsg(null);
    try {
      const res = await fetch(`/api/admin/titles/${slug}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        title?: {
          is_active: boolean;
          is_public: boolean;
          partner_id: string | null;
        };
        error?: string;
      };
      if (!res.ok || !json.ok || !json.title) {
        setState("error");
        setErrorMsg(json.error ?? `request failed (${res.status})`);
        setIsActive(initialIsActive);
        setIsPublic(initialIsPublic);
        return null;
      }
      setIsActive(json.title.is_active);
      setIsPublic(json.title.is_public);
      setState("idle");
      return json.title;
    } catch (err) {
      setState("error");
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setIsActive(initialIsActive);
      setIsPublic(initialIsPublic);
      return null;
    }
  }

  async function changePartner(nextId: string) {
    if (partnerBusy) return;
    if (nextId === partnerId) {
      setPickerOpen(false);
      return;
    }
    const target = allPartners.find((p) => p.id === nextId);
    if (!target) return;
    setPartnerBusy(true);
    setErrorMsg(null);
    const updated = await patch({ partner_id: nextId });
    setPartnerBusy(false);
    if (updated) {
      setPartnerId(target.id);
      setPartnerName(target.name);
      setPartnerSlug(target.slug);
      setPickerOpen(false);
    }
  }

  async function detachPartner() {
    if (partnerBusy || !partnerId) return;
    const ok = window.confirm(
      `Detach "${titleName}" from ${partnerName ?? "its partner"}?\n\nThe title leaves the /admin titles list and ${partnerName ?? "the partner"}'s CPM rate for it is soft-deleted (no new earnings accrue). Re-attach any time via /admin → "+ Activate new title".`,
    );
    if (!ok) return;
    setPartnerBusy(true);
    setErrorMsg(null);
    const updated = await patch({ partner_id: null });
    setPartnerBusy(false);
    if (updated) {
      setPartnerId(null);
      setPartnerName(null);
      setPartnerSlug(null);
    }
  }

  function toggleActive() {
    if (state === "saving") return;
    if (isActive) {
      const ok = window.confirm(
        `Deactivate "${titleName}"?\n\nPauses CPM payouts and (if Public is on) flips Public off too. Reactivate any time.`,
      );
      if (!ok) return;
      setIsActive(false);
      setIsPublic(false);
      void patch({ is_active: false });
    } else {
      setIsActive(true);
      void patch({ is_active: true });
    }
  }

  function togglePublic() {
    if (state === "saving") return;
    if (!isActive) {
      setState("error");
      setErrorMsg("Activate first — Public requires Active.");
      return;
    }
    const next = !isPublic;
    setIsPublic(next);
    void patch({ is_public: next });
  }

  return (
    <div className="flex flex-col gap-6">
      <section className="rounded-2xl border border-white/10 bg-white/[0.02] p-6">
        <h2 className="m-0 text-body font-medium text-moonbeem-ink">Poster</h2>
        <p className="mt-1 text-caption text-moonbeem-ink-subtle">
          The image shown on <code className="font-mono">/t/{slug}</code> and on
          cards across the site. Upload a file (stored durably on R2) or paste a
          URL.
        </p>
        <PosterEditor titleId={titleId} initialPosterUrl={initialPosterUrl} />
      </section>

      <EpisodesEditor titleId={titleId} titleSlug={slug} />

      <DetailsEditor
        titleId={titleId}
        titleSlug={slug}
        initialMetadata={initialMetadata}
      />

      <section className="rounded-2xl border border-white/10 bg-white/[0.02] p-6">
        <h2 className="m-0 text-body font-medium text-moonbeem-ink">
          Status
        </h2>
        <p className="mt-1 text-caption text-moonbeem-ink-subtle">
          Active gates the operational pipeline. Public additionally exposes{" "}
          <code className="font-mono">/t/{slug}</code> to anonymous visitors.
        </p>

        <div className="mt-5 flex flex-col gap-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-body-sm font-medium text-moonbeem-ink">
                Active
              </div>
              <div className="text-caption text-moonbeem-ink-subtle">
                CPM payouts, partner dashboard, view tracking
              </div>
            </div>
            <button
              type="button"
              onClick={toggleActive}
              disabled={state === "saving"}
              className={`rounded-md px-4 py-2 text-body-sm font-semibold transition-opacity disabled:cursor-not-allowed disabled:opacity-50 ${
                isActive
                  ? "bg-moonbeem-pink text-moonbeem-navy hover:opacity-90"
                  : "border border-white/15 text-moonbeem-ink hover:border-moonbeem-pink/40"
              }`}
            >
              {isActive ? "Active · click to pause" : "Activate"}
            </button>
          </div>

          <div className="flex items-center justify-between gap-4">
            <div>
              <div
                className={`text-body-sm font-medium ${isActive ? "text-moonbeem-ink" : "text-moonbeem-ink-subtle"}`}
              >
                Public
              </div>
              <div className="text-caption text-moonbeem-ink-subtle">
                /t/{slug} visible to anonymous visitors
              </div>
            </div>
            <button
              type="button"
              onClick={togglePublic}
              disabled={!isActive || state === "saving"}
              className={`rounded-md px-4 py-2 text-body-sm font-semibold transition-opacity disabled:cursor-not-allowed disabled:opacity-50 ${
                isPublic
                  ? "bg-moonbeem-violet/40 text-moonbeem-ink hover:opacity-90"
                  : "border border-white/15 text-moonbeem-ink hover:border-moonbeem-pink/40"
              }`}
            >
              {isPublic ? "Public · click to hide" : "Make public"}
            </button>
          </div>
        </div>

        {errorMsg && (
          <p className="mt-3 text-caption text-moonbeem-magenta">{errorMsg}</p>
        )}
      </section>

      <section className="rounded-2xl border border-white/10 bg-white/[0.02] p-6">
        <h2 className="m-0 text-body font-medium text-moonbeem-ink">
          Partner attribution
        </h2>
        {partnerId && partnerSlug ? (
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <p className="m-0 text-body-sm text-moonbeem-ink-muted">
              Attached to{" "}
              <Link
                href={`/p/${partnerSlug}`}
                className="text-moonbeem-pink hover:opacity-90"
              >
                {partnerName ?? partnerSlug}
              </Link>
              .
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setPickerChoice(partnerId);
                  setPickerOpen(true);
                }}
                disabled={partnerBusy}
                className="rounded-md border border-white/15 px-3 py-1 text-caption text-moonbeem-ink hover:border-moonbeem-pink/40 hover:text-moonbeem-pink disabled:cursor-not-allowed disabled:opacity-50"
              >
                Change
              </button>
              <button
                type="button"
                onClick={detachPartner}
                disabled={partnerBusy}
                className="rounded-md border border-moonbeem-magenta/30 px-3 py-1 text-caption text-moonbeem-magenta hover:bg-moonbeem-magenta/10 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {partnerBusy ? "Detaching…" : "Detach"}
              </button>
            </div>
          </div>
        ) : (
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <p className="m-0 text-body-sm text-moonbeem-ink-muted">
              No partner attached.
            </p>
            <button
              type="button"
              onClick={() => {
                setPickerChoice("");
                setPickerOpen(true);
              }}
              className="rounded-md bg-moonbeem-pink px-3 py-1 text-caption font-semibold text-moonbeem-navy hover:opacity-90"
            >
              Attach to partner
            </button>
          </div>
        )}

        {pickerOpen && (
          <div className="mt-4 rounded-lg border border-white/10 bg-black/30 p-4">
            <div className="flex items-center justify-between gap-3">
              <span className="text-body-sm font-medium text-moonbeem-ink">
                Pick a partner
              </span>
              <button
                type="button"
                onClick={() => setPickerOpen(false)}
                className="text-caption text-moonbeem-ink-muted hover:text-moonbeem-pink"
              >
                Cancel
              </button>
            </div>
            <select
              value={pickerChoice}
              onChange={(e) => setPickerChoice(e.target.value)}
              className="mt-3 w-full rounded-md border border-white/10 bg-black/30 px-3 py-2 text-body-sm text-moonbeem-ink focus:border-moonbeem-pink focus:outline-none"
            >
              <option value="">— select a partner —</option>
              {allPartners.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.slug})
                </option>
              ))}
            </select>
            <div className="mt-3 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => changePartner(pickerChoice)}
                disabled={!pickerChoice || partnerBusy || pickerChoice === partnerId}
                className="rounded-md bg-moonbeem-pink px-4 py-1.5 text-body-sm font-semibold text-moonbeem-navy hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {partnerBusy ? "Saving…" : "Save"}
              </button>
            </div>
            {partnerId && (
              <p className="mt-3 text-caption text-moonbeem-ink-subtle">
                Reassigning soft-deletes {partnerName ?? "the prior partner"}
                &apos;s CPM rate for this title — they stop accruing new
                earnings (history is preserved).
              </p>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

function AnalyticsTab({
  titleSlug,
  activeWindow,
  data,
}: {
  titleSlug: string;
  activeWindow: TimeWindow;
  data: AnalyticsData | null;
}) {
  // Server should have populated data when ?tab=analytics; null means
  // we just navigated and the route is still re-rendering. Render a
  // shell so the layout doesn't jump.
  if (!data) {
    return (
      <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-8 text-center">
        <p className="text-body-sm text-moonbeem-ink-muted m-0">
          Loading analytics…
        </p>
      </div>
    );
  }

  // Reconstruct the Map that UsStateChoropleth expects (we pass a plain
  // object across the server/client boundary).
  const stateMap = new Map(Object.entries(data.stateData));

  return (
    <div className="flex flex-col gap-10">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-body-sm text-moonbeem-ink-muted mr-1">
          Window:
        </span>
        {TIME_WINDOWS.map((w) => {
          const active = w === activeWindow;
          const qs = new URLSearchParams();
          qs.set("tab", "analytics");
          if (w !== "7d") qs.set("window", w);
          return (
            <Link
              key={w}
              href={`/admin/titles/${titleSlug}?${qs.toString()}`}
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
          {windowLabel(activeWindow)}
        </span>
      </div>

      <section className="grid grid-cols-2 gap-3 md:grid-cols-3 md:gap-4">
        <HeroNumber
          value={data.events.toLocaleString()}
          label="Engagement events"
        />
        <HeroNumber
          value={data.uniqueSignedInUsers.toLocaleString()}
          label="Signed-in users (window)"
        />
        <HeroNumber
          value={data.clicks.toLocaleString()}
          label="/go/ clicks (humans)"
        />
        <HeroNumber
          value={data.totalSocialViews.toLocaleString()}
          label="Total social views"
        />
        <HeroNumber
          value={data.fanEditsCount.toLocaleString()}
          label="Active fan edits"
        />
        <HeroNumber
          value={data.openRequests.toLocaleString()}
          label="Open title requests"
        />
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-display-sm m-0">Engagement over time</h2>
        <p className="text-body-sm text-moonbeem-ink-muted m-0">
          Fan-edit modal events for this title ·{" "}
          {activeWindow === "24h" ? "hourly" : "daily"} buckets
        </p>
        <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
          {data.timeSeries.length === 0 ? (
            <p className="text-body-sm text-moonbeem-ink-muted text-center py-12 m-0">
              No engagement events in this window.
            </p>
          ) : (
            <TimeSeriesChart data={data.timeSeries} yLabel="events" />
          )}
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-display-sm m-0">Geography</h2>
        <p className="text-body-sm text-moonbeem-ink-muted m-0">
          /go/ click + consent-gated event origins for this title ·{" "}
          {data.totalGeoEvents.toLocaleString()} geo-tagged event
          {data.totalGeoEvents === 1 ? "" : "s"} in window
        </p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="md:col-span-2 rounded-2xl border border-white/10 bg-white/[0.02] p-4">
            <UsStateChoropleth data={stateMap} height={360} />
          </div>
          <div className="flex flex-col">
            <DataTable<CityCount>
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
              rows={data.cityBreakdown.slice(0, 10)}
              rowKey={(r) =>
                `${r.country_code ?? ""}|${r.region_code ?? ""}|${r.city}`
              }
              emptyMessage="No location data available for this window."
              maxHeightClass="max-h-[360px]"
            />
          </div>
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-display-sm m-0">Fan edits</h2>
        <p className="text-body-sm text-moonbeem-ink-muted m-0">
          Every active fan edit for this title. View counts are lifetime;
          modal opens and platform clicks are window-scoped.
        </p>
        <DataTable<AnalyticsFanEditRow>
          columns={getFanEditComparisonColumns()}
          rows={data.fanEditsComparison}
          rowKey={(r) => r.id}
          emptyMessage="No active fan edits for this title yet."
        />
      </section>
    </div>
  );
}

function getFanEditComparisonColumns(): Column<AnalyticsFanEditRow>[] {
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
      render: (r) => r.view_count.toLocaleString(),
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
