"use client";

import Image from "next/image";
import Link from "next/link";
import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import FanEditsUploadCard from "@/components/admin/FanEditsUploadCard";
import UploadClient from "./upload/UploadClient";
import DiscoverTab from "./DiscoverTab";

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
  | "upload"
  | "settings";

type PartnerOption = { id: string; slug: string; name: string };

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
  allPartners: PartnerOption[];
  fanEdits: FanEditRow[];
  clips: ClipRow[];
  stills: StillRow[];
  activeTab: Tab;
};

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "fan-edits", label: "Fan edits" },
  { id: "clips", label: "Clips" },
  { id: "stills", label: "Stills" },
  { id: "discover", label: "Discover" },
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
    <div className="min-h-screen px-6 py-12 bg-[radial-gradient(ellipse_at_top,_#1a0f3a_0%,_#0a0a14_60%)]">
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
          <h1 className="font-wordmark text-display-lg text-moonbeem-ink m-0">
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
          {tab === "upload" && (
            <UploadTab
              titleId={props.titleId}
              titleName={props.titleName}
              titleSlug={props.titleSlug}
            />
          )}
          {tab === "settings" && (
            <SettingsTab
              slug={props.titleSlug}
              titleName={props.titleName}
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

  async function deleteClip(id: string, label: string | null) {
    const ok = window.confirm(
      `Soft-delete clip ${label ?? id}? It will disappear from the public title page immediately. (Restorable from SQL today.)`,
    );
    if (!ok) return;
    setBusyId(id);
    setErrorId(null);
    setErrorMsg(null);
    try {
      const res = await fetch(`/api/admin/clips/${id}/delete`, {
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
          c.id === id ? { ...c, deleted_at: new Date().toISOString() } : c,
        ),
      );
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
                    onClick={() => deleteClip(c.id, c.label)}
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
                <span className="truncate">
                  {c.label ?? c.file_url ?? "(unnamed)"} ·{" "}
                  {formatDuration(c.duration_seconds)} ·{" "}
                  {formatBytes(c.file_size_bytes)}
                </span>
                <span className="font-mono">
                  {c.deleted_at &&
                    new Date(c.deleted_at).toLocaleDateString()}
                </span>
              </li>
            ))}
          </ul>
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

  async function deleteStill(id: string, alt: string | null) {
    const ok = window.confirm(
      `Soft-delete still ${alt ?? id}? It will disappear from the public title page immediately. (Restorable from SQL today.)`,
    );
    if (!ok) return;
    setBusyId(id);
    setErrorId(null);
    setErrorMsg(null);
    try {
      const res = await fetch(`/api/admin/stills/${id}/delete`, {
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
          s.id === id ? { ...s, deleted_at: new Date().toISOString() } : s,
        ),
      );
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
                  onClick={() => deleteStill(s.id, s.alt_text)}
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
                <span className="truncate">
                  {s.alt_text ?? s.file_url ?? "(unnamed)"} ·{" "}
                  {formatBytes(s.file_size_bytes)}
                </span>
                <span className="font-mono">
                  {s.deleted_at &&
                    new Date(s.deleted_at).toLocaleDateString()}
                </span>
              </li>
            ))}
          </ul>
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

type SettingsState = "idle" | "saving" | "error";

function SettingsTab({
  slug,
  titleName,
  initialIsActive,
  initialIsPublic,
  initialPartnerId,
  initialPartnerName,
  initialPartnerSlug,
  allPartners,
}: {
  slug: string;
  titleName: string;
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
