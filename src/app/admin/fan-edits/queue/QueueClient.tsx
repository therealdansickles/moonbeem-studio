"use client";

import Link from "next/link";
import { useState } from "react";
import type { PendingQueueRow } from "@/lib/queries/titles";

type Props = { initialRows: PendingQueueRow[] };

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return "just now";
  const min = Math.round(diff / 60_000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.round(hr / 24);
  return `${d}d ago`;
}

function platformLabel(p: string): string {
  if (p === "tiktok") return "TikTok";
  if (p === "instagram") return "Instagram";
  if (p === "twitter") return "X";
  if (p === "youtube") return "YouTube";
  return p;
}

export default function QueueClient({ initialRows }: Props) {
  const [rows, setRows] = useState<PendingQueueRow[]>(initialRows);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function approve(id: string) {
    if (busyId) return;
    setBusyId(id);
    setError(null);
    try {
      const res = await fetch(`/api/admin/fan-edits/${id}/approve`, {
        method: "POST",
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        setError(json.error ?? "approve failed");
        return;
      }
      setRows((prev) => prev.filter((r) => r.id !== id));
    } finally {
      setBusyId(null);
    }
  }

  async function reject(id: string) {
    if (busyId) return;
    if (!rejectReason.trim()) {
      setError("rejection reason required");
      return;
    }
    setBusyId(id);
    setError(null);
    try {
      const res = await fetch(`/api/admin/fan-edits/${id}/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: rejectReason.trim() }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        setError(json.error ?? "reject failed");
        return;
      }
      setRows((prev) => prev.filter((r) => r.id !== id));
      setRejectingId(null);
      setRejectReason("");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="min-h-screen px-6 py-12 text-moonbeem-ink">
      <div className="max-w-5xl mx-auto flex flex-col gap-6">
        <div className="flex items-center justify-between gap-4">
          <div className="flex flex-col gap-1">
            <p className="text-body-sm text-moonbeem-ink-subtle uppercase tracking-wider">
              Admin — fan edits
            </p>
            <h1 className="font-wordmark font-bold text-display-md text-moonbeem-pink m-0">
              Review queue
            </h1>
            <p className="text-body-sm text-moonbeem-ink-muted">
              {rows.length} pending · FIFO (oldest first)
            </p>
          </div>
          <Link
            href="/admin"
            className="text-body-sm text-moonbeem-ink-muted hover:text-moonbeem-pink"
          >
            ← Admin
          </Link>
        </div>

        {error && (
          <div className="rounded-md border border-moonbeem-magenta/40 bg-moonbeem-magenta/10 px-3 py-2 text-body-sm text-moonbeem-magenta">
            {error}
          </div>
        )}

        {rows.length === 0 ? (
          <p className="rounded-md border border-white/10 bg-white/[0.02] p-6 text-body-sm text-moonbeem-ink-muted">
            No pending submissions.
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {rows.map((r) => (
              <li
                key={r.id}
                className="flex flex-col gap-3 rounded-md border border-white/10 bg-white/[0.02] p-4"
              >
                <div className="flex items-start gap-4">
                  {r.thumbnail_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={r.thumbnail_url}
                      alt=""
                      width={80}
                      height={80}
                      className="h-20 w-20 shrink-0 rounded-md object-cover bg-black/40"
                    />
                  ) : (
                    <div className="h-20 w-20 shrink-0 rounded-md bg-black/40" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="text-body-sm text-moonbeem-ink-subtle uppercase tracking-wider">
                      {platformLabel(r.platform)} · {r.post_id ?? "?"}
                    </p>
                    <p className="mt-1 text-body text-moonbeem-ink">
                      <Link
                        href={`/t/${r.title_slug}`}
                        className="hover:text-moonbeem-pink"
                      >
                        {r.title_name}
                      </Link>
                    </p>
                    <p className="text-body-sm text-moonbeem-ink-muted">
                      Submitted by{" "}
                      {r.submitter_handle ? (
                        <Link
                          href={`/c/${r.submitter_handle}`}
                          className="hover:text-moonbeem-pink"
                        >
                          @{r.submitter_handle}
                        </Link>
                      ) : (
                        r.submitter_email ?? "—"
                      )}{" "}
                      · {timeAgo(r.created_at)}
                    </p>
                    <a
                      href={r.embed_url}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-1 inline-block text-body-sm text-moonbeem-ink-muted hover:text-moonbeem-pink truncate"
                    >
                      {r.embed_url}
                    </a>
                  </div>
                  <div className="flex shrink-0 flex-col gap-2">
                    <button
                      type="button"
                      onClick={() => approve(r.id)}
                      disabled={busyId === r.id}
                      className="rounded-md border border-emerald-700 bg-emerald-950/40 px-3 py-1 text-body-sm text-emerald-300 hover:bg-emerald-950/60 disabled:opacity-40"
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setRejectingId(rejectingId === r.id ? null : r.id);
                        setRejectReason("");
                        setError(null);
                      }}
                      disabled={busyId === r.id}
                      className="rounded-md border border-white/15 px-3 py-1 text-body-sm text-moonbeem-ink-muted hover:border-moonbeem-magenta hover:text-moonbeem-magenta disabled:opacity-40"
                    >
                      Reject
                    </button>
                  </div>
                </div>

                {rejectingId === r.id && (
                  <div className="flex flex-col gap-2 border-t border-white/5 pt-3">
                    <label className="flex flex-col gap-1">
                      <span className="text-body-sm text-moonbeem-ink-muted">
                        Rejection reason (max 500 chars, included in email)
                      </span>
                      <textarea
                        value={rejectReason}
                        onChange={(e) => setRejectReason(e.target.value)}
                        rows={3}
                        maxLength={500}
                        placeholder="e.g. The edit covers multiple films, attribution requires partner sign-off we don't have, or the connection to the title wasn't clear."
                        className="w-full bg-transparent border border-white/15 rounded-md px-3 py-2 text-body-sm text-moonbeem-ink placeholder:text-moonbeem-ink-subtle focus:outline-none focus:border-moonbeem-magenta"
                      />
                    </label>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => reject(r.id)}
                        disabled={busyId === r.id || !rejectReason.trim()}
                        className="rounded-md bg-moonbeem-magenta px-3 py-1.5 text-body-sm font-semibold text-white disabled:opacity-40 hover:opacity-90"
                      >
                        {busyId === r.id ? "Rejecting…" : "Confirm reject"}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setRejectingId(null);
                          setRejectReason("");
                        }}
                        className="text-body-sm text-moonbeem-ink-muted hover:text-moonbeem-ink"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
