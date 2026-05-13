"use client";

/**
 * CTA architecture note (May 2026):
 *
 * This component currently handles two states: "Request fan edits"
 * (with idempotent submitted-state tracking) and the auth-gate
 * redirect for signed-out users. The In Theaters CTA renders
 * separately from the offers stack on the title page.
 *
 * Future states this component (or a parent CTA orchestrator) will
 * need to handle:
 * - Theatrical: ticket purchase links (Atom Tickets, Fandango, etc.)
 * - Pre-TVOD: "Coming soon to digital" placeholder
 * - TVOD live: multiple destinations (Apple TV, Amazon, Vudu,
 *   Moonbeem rental via Stripe Connect)
 * - Post-TVOD streaming: subscription destinations (Netflix, Mubi,
 *   Criterion Channel)
 * - Library / archival: no transactional CTA, just request flows
 *
 * Plus the orthogonal request_type axis: fan_edits vs
 * clips_and_stills (schema is ready; UI is single-button today).
 *
 * Open architectural questions when these states ship:
 * 1. Single CTA vs. stacked CTAs when multiple destinations exist
 * 2. Where the request CTA fits in priority hierarchy when
 *    transactional options are live (probably demoted to secondary)
 *
 * Don't refactor toward this prematurely — the right design will
 * come from real distributor TVOD link requirements.
 */

import { useState } from "react";
import { formatRelativeDays } from "@/lib/relative-time";
import {
  fetchJson,
  FetchJsonError,
  RateLimitedError,
} from "@/lib/fetch-json";

type Props = {
  titleId: string;
  titleName: string;
  titleSlug: string;
  alreadyRequested: boolean;
  requestedAt: string | null;
};

type Status = "idle" | "submitting" | "done" | "error";

export default function RequestFanEditsCTA({
  titleId,
  titleName,
  titleSlug,
  alreadyRequested,
  requestedAt,
}: Props) {
  const [status, setStatus] = useState<Status>(
    alreadyRequested ? "done" : "idle",
  );
  const [submittedAt, setSubmittedAt] = useState<string | null>(requestedAt);
  const [errorMsg, setErrorMsg] = useState("");

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
          request_type: "fan_edits",
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
      <div
        className="flex items-center gap-2 text-body-sm text-moonbeem-ink-muted animate-fade-in"
        role="status"
        aria-live="polite"
      >
        <svg
          className="h-4 w-4 text-moonbeem-pink shrink-0"
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
        <span>{when ? `Fan edit request submitted ${when}` : "Fan edit request submitted"}</span>
      </div>
    );
  }

  const label =
    status === "submitting"
      ? "Requesting..."
      : `Request fan edits for ${titleName}`;

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
