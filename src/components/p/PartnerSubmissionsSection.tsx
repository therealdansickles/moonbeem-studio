"use client";

// Pending-fan_edit-submissions queue on /p/[slug]/dashboard. Lists
// every fan_edit with verification_status='pending' on a title
// owned by this partner. Partner-admins can approve or reject each
// one in place; viewers see the queue read-only with disabled
// action buttons.
//
// Reject UI: clicking "Reject" expands an inline form with an
// optional reason textarea (max 500 chars). Reason is
// partner-internal audit only — the partner-decide API does not
// send the creator a notification on rejection (super-admin reject
// does, but partner-side moderation is intentionally silent in v1).
//
// Approve confirms via window.confirm() because approval is
// irreversible-ish: it fulfills any open title_requests for the
// title AND sends the creator an "approved" email. Reject's inline
// form acts as its own confirmation (Confirm Reject / Cancel).

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import {
  fetchJson,
  FetchJsonError,
  RateLimitedError,
} from "@/lib/fetch-json";

export type PartnerSubmission = {
  id: string;
  title_id: string;
  title_name: string;
  title_slug: string;
  platform: "tiktok" | "instagram" | "youtube" | "twitter";
  embed_url: string;
  thumbnail_url: string | null;
  creator_handle: string;
  created_at: string;
};

type Props = {
  partnerSlug: string;
  isAdmin: boolean;
  initialSubmissions: PartnerSubmission[];
  titles: { id: string; slug: string; title: string }[];
};

const REASON_MAX = 500;

function humanizeErr(err: unknown): string {
  if (err instanceof RateLimitedError || err instanceof FetchJsonError) {
    return err.userMessage;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

export default function PartnerSubmissionsSection({
  partnerSlug,
  isAdmin,
  initialSubmissions,
  titles,
}: Props) {
  const router = useRouter();
  const [submissions, setSubmissions] =
    useState<PartnerSubmission[]>(initialSubmissions);
  const [titleFilter, setTitleFilter] = useState<string>("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState("");

  const filtered = useMemo(() => {
    if (!titleFilter) return submissions;
    return submissions.filter((s) => s.title_id === titleFilter);
  }, [submissions, titleFilter]);

  async function handleApprove(s: PartnerSubmission) {
    if (busyId || !isAdmin) return;
    const ok = window.confirm(
      `Approve "${s.title_name}" by @${s.creator_handle}?\n\nThis will close any open requests for this title and email the creator.`,
    );
    if (!ok) return;
    setBusyId(s.id);
    setErrorMsg(null);
    const prev = submissions;
    setSubmissions(prev.filter((x) => x.id !== s.id));
    try {
      await fetchJson(`/api/p/${partnerSlug}/fan-edits/${s.id}/decide`, {
        method: "POST",
        body: { decision: "approved" },
      });
      router.refresh();
    } catch (err) {
      setSubmissions(prev);
      setErrorMsg(humanizeErr(err));
    } finally {
      setBusyId(null);
    }
  }

  function openRejectForm(s: PartnerSubmission) {
    if (busyId || !isAdmin) return;
    setRejectingId(s.id);
    setRejectReason("");
    setErrorMsg(null);
  }

  function cancelReject() {
    setRejectingId(null);
    setRejectReason("");
  }

  async function confirmReject(s: PartnerSubmission) {
    if (busyId || !isAdmin) return;
    const reason = rejectReason.trim();
    if (reason.length > REASON_MAX) {
      setErrorMsg(`Reason too long (max ${REASON_MAX} chars).`);
      return;
    }
    setBusyId(s.id);
    setErrorMsg(null);
    const prev = submissions;
    setSubmissions(prev.filter((x) => x.id !== s.id));
    try {
      await fetchJson(`/api/p/${partnerSlug}/fan-edits/${s.id}/decide`, {
        method: "POST",
        body: {
          decision: "rejected",
          ...(reason.length > 0 ? { reason } : {}),
        },
      });
      router.refresh();
    } catch (err) {
      setSubmissions(prev);
      setErrorMsg(humanizeErr(err));
    } finally {
      setBusyId(null);
      setRejectingId(null);
      setRejectReason("");
    }
  }

  return (
    <section className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
      <div className="flex flex-wrap items-center gap-3">
        <span className="rounded-full bg-moonbeem-pink/15 px-2.5 py-0.5 text-caption font-medium text-moonbeem-pink">
          Submissions
        </span>
        <span className="text-caption text-moonbeem-ink-subtle">
          {submissions.length}{" "}
          {submissions.length === 1 ? "pending" : "pending"}
        </span>
      </div>
      <p className="mt-1 text-body-sm text-moonbeem-ink-muted m-0">
        {isAdmin
          ? "Review and approve fan edits submitted to your titles. Approving closes any open requests for the title and notifies the creator; rejecting removes the edit from public surfaces without notifying the creator."
          : "Pending fan edits submitted to your titles. Approving and rejecting is an admin-only action."}
      </p>

      {errorMsg && (
        <p className="mt-3 text-body-sm text-moonbeem-magenta">{errorMsg}</p>
      )}

      {titles.length > 1 && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <label
            htmlFor="submissions-title-filter"
            className="text-caption text-moonbeem-ink-subtle"
          >
            Filter by title
          </label>
          <select
            id="submissions-title-filter"
            value={titleFilter}
            onChange={(e) => setTitleFilter(e.target.value)}
            className="rounded-md border border-white/10 bg-black/30 px-3 py-1.5 text-body-sm text-moonbeem-ink focus:border-moonbeem-pink focus:outline-none"
          >
            <option value="">All titles</option>
            {titles.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="mt-4">
        {filtered.length === 0 ? (
          <p className="text-body-sm text-moonbeem-ink-muted m-0">
            {submissions.length === 0
              ? "No pending submissions."
              : "No submissions match the current filter."}
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {filtered.map((s) => {
              const isRejecting = rejectingId === s.id;
              const isBusy = busyId === s.id;
              return (
                <li
                  key={s.id}
                  className="flex flex-col gap-3 rounded-md border border-white/10 bg-white/[0.02] p-3"
                >
                  <div className="flex items-center gap-3">
                    {s.thumbnail_url ? (
                      <div className="h-[60px] w-[40px] shrink-0 overflow-hidden rounded-sm bg-white/[0.03]">
                        <Image
                          src={s.thumbnail_url}
                          alt={`${s.title_name} submission thumbnail`}
                          width={40}
                          height={60}
                          className="h-full w-full object-cover"
                          unoptimized
                        />
                      </div>
                    ) : (
                      <div
                        className="h-[60px] w-[40px] shrink-0 rounded-sm border border-white/10 bg-white/[0.03]"
                        aria-hidden="true"
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-body-sm text-moonbeem-ink">
                        {s.title_name}
                      </div>
                      <div className="truncate font-mono text-caption text-moonbeem-ink-subtle">
                        @{s.creator_handle} · {s.platform} · submitted{" "}
                        {new Date(s.created_at).toLocaleDateString()}
                      </div>
                      <div className="mt-0.5 text-caption">
                        <Link
                          href={s.embed_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-moonbeem-ink-muted hover:text-moonbeem-pink"
                        >
                          View on {s.platform} ↗
                        </Link>
                        <span className="mx-2 text-moonbeem-ink-subtle">
                          ·
                        </span>
                        <Link
                          href={`/t/${s.title_slug}`}
                          className="text-moonbeem-ink-muted hover:text-moonbeem-pink"
                        >
                          /t/{s.title_slug}
                        </Link>
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-col items-stretch gap-2 sm:flex-row">
                      <button
                        type="button"
                        onClick={() => handleApprove(s)}
                        disabled={!isAdmin || isBusy || isRejecting}
                        title={
                          !isAdmin
                            ? "Admin-only action"
                            : undefined
                        }
                        className="rounded-md border border-white/10 px-3 py-1.5 text-body-sm text-moonbeem-ink-muted transition-colors hover:border-moonbeem-pink hover:text-moonbeem-pink disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        onClick={() => openRejectForm(s)}
                        disabled={!isAdmin || isBusy || isRejecting}
                        title={
                          !isAdmin
                            ? "Admin-only action"
                            : undefined
                        }
                        className="rounded-md border border-white/10 px-3 py-1.5 text-body-sm text-moonbeem-ink-muted transition-colors hover:border-moonbeem-magenta hover:text-moonbeem-magenta disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        Reject
                      </button>
                    </div>
                  </div>

                  {isRejecting && (
                    <div className="flex flex-col gap-2 rounded-md border border-moonbeem-magenta/30 bg-moonbeem-magenta/[0.04] p-3">
                      <label
                        htmlFor={`reject-reason-${s.id}`}
                        className="text-caption text-moonbeem-ink-subtle"
                      >
                        Optional reason (partner-internal audit only;
                        the creator is not notified)
                      </label>
                      <textarea
                        id={`reject-reason-${s.id}`}
                        value={rejectReason}
                        onChange={(e) => setRejectReason(e.target.value)}
                        maxLength={REASON_MAX}
                        rows={2}
                        placeholder="e.g. doesn't match our brand guidelines"
                        className="rounded-md border border-white/10 bg-black/30 px-3 py-2 text-body-sm text-moonbeem-ink placeholder:text-moonbeem-ink-subtle focus:border-moonbeem-pink focus:outline-none"
                      />
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-caption text-moonbeem-ink-subtle tabular-nums">
                          {rejectReason.length} / {REASON_MAX}
                        </span>
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={cancelReject}
                            disabled={isBusy}
                            className="rounded-md border border-white/10 px-3 py-1.5 text-body-sm text-moonbeem-ink-muted transition-colors hover:border-moonbeem-pink hover:text-moonbeem-pink disabled:opacity-40"
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            onClick={() => confirmReject(s)}
                            disabled={isBusy}
                            className="rounded-md border border-moonbeem-magenta/60 bg-moonbeem-magenta/10 px-3 py-1.5 text-body-sm text-moonbeem-magenta transition-colors hover:bg-moonbeem-magenta/20 disabled:opacity-40"
                          >
                            Confirm Reject
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
