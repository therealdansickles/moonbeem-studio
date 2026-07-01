"use client";

/**
 * Request-content CTA (generalized May→Jul 2026):
 *
 * One button + idempotent submitted-state + signed-out auth-gate
 * redirect, parametrized by requestType ("fan_edits" | "clips" |
 * "stills"). It posts to /api/titles/request with the given
 * request_type. Copy (idle action + submitted confirmation) is derived
 * from a per-type label map; everything else (the POST, the 401 hard-
 * redirect, the checkmark/relative-time done state) is type-neutral.
 *
 * fan_edits has no caller today (Piece 2 relocated the ask into the
 * Clips/Stills tabs), but the capability is retained intentionally.
 *
 * Future states a parent CTA orchestrator will fold in (theatrical
 * ticket links, TVOD destinations, streaming subscriptions) are still
 * out of scope — don't refactor toward them until real distributor
 * link requirements land.
 */

import { useState } from "react";
import { formatRelativeDays } from "@/lib/relative-time";
import {
  fetchJson,
  FetchJsonError,
  RateLimitedError,
} from "@/lib/fetch-json";

type RequestType = "fan_edits" | "clips" | "stills";

type Props = {
  requestType: RequestType;
  titleId: string;
  titleName: string;
  titleSlug: string;
  // Optional idempotent "already submitted" seed. Retained so any caller
  // can precompute an open request and open in the done state; the
  // clips/stills empty-state callers omit them (always render idle).
  alreadyRequested?: boolean;
  requestedAt?: string | null;
};

type Status = "idle" | "submitting" | "done" | "error";

// Per-type copy. `action` is prefixed to the title name for the idle
// button; `submitted` is the done-state confirmation.
const LABELS: Record<RequestType, { action: string; submitted: string }> = {
  fan_edits: {
    action: "Request fan edits for",
    submitted: "Fan edit request submitted",
  },
  clips: {
    action: "Request clips for",
    submitted: "Clip request submitted",
  },
  stills: {
    action: "Request stills for",
    submitted: "Still request submitted",
  },
};

export default function RequestContentCTA({
  requestType,
  titleId,
  titleName,
  titleSlug,
  alreadyRequested = false,
  requestedAt = null,
}: Props) {
  const [status, setStatus] = useState<Status>(
    alreadyRequested ? "done" : "idle",
  );
  const [submittedAt, setSubmittedAt] = useState<string | null>(requestedAt);
  const [errorMsg, setErrorMsg] = useState("");

  const labels = LABELS[requestType];

  async function onClick() {
    if (status !== "idle") return;
    setStatus("submitting");
    setErrorMsg("");
    try {
      const data = await fetchJson<{
        already_requested?: boolean;
        requested_at?: string | null;
        requires_auth?: boolean;
        redirect_to?: string;
      }>("/api/titles/request", {
        method: "POST",
        body: {
          title_id: titleId,
          redirect_to: `/t/${titleSlug}`,
          title_name: titleName,
          request_type: requestType,
        },
      });

      if (data.already_requested && data.requested_at) {
        setSubmittedAt(data.requested_at);
      } else {
        setSubmittedAt(new Date().toISOString());
      }
      setStatus("done");
    } catch (err) {
      // 401 from the route includes a redirect_to to /login — fetchJson
      // throws FetchJsonError with status 401 + payload containing the
      // redirect. Honor it before surfacing any error UI.
      if (err instanceof FetchJsonError && err.status === 401) {
        const p = err.payload as
          | { requires_auth?: boolean; redirect_to?: string }
          | null;
        if (p?.requires_auth && p.redirect_to) {
          window.location.href = p.redirect_to;
          return;
        }
      }
      setStatus("error");
      if (err instanceof RateLimitedError) {
        setErrorMsg(err.userMessage);
      } else if (err instanceof FetchJsonError) {
        setErrorMsg(err.userMessage);
      } else {
        setErrorMsg(err instanceof Error ? err.message : String(err));
      }
    }
  }

  if (status === "done") {
    const when = submittedAt ? formatRelativeDays(submittedAt) : null;
    return (
      <div className="flex flex-col items-center gap-2">
        <button
          type="button"
          disabled
          aria-disabled="true"
          className="bg-moonbeem-pink text-moonbeem-navy rounded-md px-6 py-3 text-body font-semibold hover:opacity-90 disabled:opacity-60 disabled:cursor-default transition-opacity inline-flex items-center gap-2"
          role="status"
          aria-live="polite"
        >
          <svg
            className="h-4 w-4 text-moonbeem-navy shrink-0"
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M3 8.5l3.5 3.5L13 5"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span>{when ? `${labels.submitted} ${when}` : labels.submitted}</span>
        </button>
      </div>
    );
  }

  const label =
    status === "submitting"
      ? "Requesting..."
      : `${labels.action} ${titleName}`;

  return (
    <div className="flex flex-col items-center gap-2">
      <button
        type="button"
        onClick={onClick}
        disabled={status === "submitting"}
        className="bg-moonbeem-pink text-moonbeem-navy rounded-md px-6 py-3 text-body font-semibold hover:opacity-90 disabled:opacity-60 disabled:cursor-default transition-opacity"
      >
        {label}
      </button>
      {status === "error" && (
        <p className="text-body-sm text-moonbeem-magenta">{errorMsg}</p>
      )}
    </div>
  );
}
