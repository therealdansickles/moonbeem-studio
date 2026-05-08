"use client";

import Image from "next/image";
import Link from "next/link";
import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import FanEditsUploadCard from "@/components/admin/FanEditsUploadCard";
import UploadClient from "./upload/UploadClient";

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

type Tab = "fan-edits" | "upload" | "settings";

type Props = {
  titleId: string;
  titleSlug: string;
  titleName: string;
  isActive: boolean;
  isPublic: boolean;
  partnerName: string | null;
  partnerSlug: string | null;
  hasPartner: boolean;
  fanEdits: FanEditRow[];
  activeTab: Tab;
};

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "fan-edits", label: "Fan edits" },
  { id: "upload", label: "Upload" },
  { id: "settings", label: "Settings" },
];

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
              </button>
            ))}
          </nav>
        </div>

        <div className="mt-8">
          {tab === "fan-edits" && (
            <FanEditsList rows={props.fanEdits} titleSlug={props.titleSlug} />
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
              partnerName={props.partnerName}
              partnerSlug={props.partnerSlug}
              hasPartner={props.hasPartner}
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
  partnerName,
  partnerSlug,
  hasPartner,
}: {
  slug: string;
  titleName: string;
  initialIsActive: boolean;
  initialIsPublic: boolean;
  partnerName: string | null;
  partnerSlug: string | null;
  hasPartner: boolean;
}) {
  const [isActive, setIsActive] = useState(initialIsActive);
  const [isPublic, setIsPublic] = useState(initialIsPublic);
  const [state, setState] = useState<SettingsState>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  async function patch(payload: {
    is_active?: boolean;
    is_public?: boolean;
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
        title?: { is_active: boolean; is_public: boolean };
        error?: string;
      };
      if (!res.ok || !json.ok || !json.title) {
        setState("error");
        setErrorMsg(json.error ?? `request failed (${res.status})`);
        setIsActive(initialIsActive);
        setIsPublic(initialIsPublic);
        return;
      }
      setIsActive(json.title.is_active);
      setIsPublic(json.title.is_public);
      setState("idle");
    } catch (err) {
      setState("error");
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setIsActive(initialIsActive);
      setIsPublic(initialIsPublic);
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
        {hasPartner ? (
          <p className="mt-3 text-body-sm text-moonbeem-ink-muted">
            Attached to{" "}
            <Link
              href={`/p/${partnerSlug}`}
              className="text-moonbeem-pink hover:opacity-90"
            >
              {partnerName ?? partnerSlug}
            </Link>
            . Detaching is a SQL operation today (set{" "}
            <code className="font-mono">titles.partner_id</code> to null).
          </p>
        ) : (
          <p className="mt-3 text-body-sm text-moonbeem-ink-muted">
            No partner attached. Set{" "}
            <code className="font-mono">titles.partner_id</code> via SQL to
            link this title to a partner.
          </p>
        )}
      </section>
    </div>
  );
}
