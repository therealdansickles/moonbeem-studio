"use client";

import Link from "next/link";
import { useState } from "react";
import type { AdminActionKey, AdminActionRun } from "@/lib/admin-action-runs";

type ActionState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "ok"; message: string }
  | { kind: "error"; message: string };

type LastRunSnapshot = {
  triggered_at: string;
  ok: boolean;
  duration_ms: number | null;
  result: unknown;
  error_message: string | null;
};

function formatResult(payload: unknown): string {
  if (payload && typeof payload === "object") {
    return JSON.stringify(payload, null, 2);
  }
  return String(payload ?? "");
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  const diff = Date.now() - then;
  if (diff < 0) return new Date(iso).toLocaleString();
  const sec = Math.round(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return new Date(iso).toLocaleString();
}

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

// Per-action one-line summary of the result payload. Falls back to
// "ok" / "failed" when the shape doesn't match.
function summarizeResult(actionKey: AdminActionKey, snap: LastRunSnapshot): string {
  if (!snap.ok) {
    return snap.error_message ? `failed — ${snap.error_message}` : "failed";
  }
  const r = snap.result as Record<string, unknown> | null;
  if (actionKey === "earnings_calculate") {
    const rows = (r?.rows_upserted as number | undefined) ?? 0;
    const cents = (r?.total_earnings_cents as number | undefined) ?? 0;
    const titles = (r?.titles_processed as number | undefined) ?? 0;
    return `${rows} row${rows === 1 ? "" : "s"} upserted · ${dollars(cents)} across ${titles} title${titles === 1 ? "" : "s"}`;
  }
  if (actionKey === "view_tracking_trigger") {
    const inner = (r?.result as Record<string, unknown> | undefined) ?? null;
    if (inner) {
      const refreshed = inner.refreshed ?? inner.processed ?? inner.updated;
      if (typeof refreshed === "number") {
        return `${refreshed} fan_edits refreshed`;
      }
      const note = inner.note ?? inner.message;
      if (typeof note === "string") return note;
    }
    return "ok";
  }
  return "ok";
}

function ActionCard({
  actionKey,
  title,
  description,
  endpoint,
  cta,
  initialLastRun,
}: {
  actionKey: AdminActionKey;
  title: string;
  description: string;
  endpoint: string;
  cta: string;
  initialLastRun: LastRunSnapshot | null;
}) {
  const [state, setState] = useState<ActionState>({ kind: "idle" });
  const [lastRun, setLastRun] = useState<LastRunSnapshot | null>(initialLastRun);

  async function run() {
    setState({ kind: "running" });
    try {
      const res = await fetch(endpoint, { method: "POST" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setState({
          kind: "error",
          message: formatResult(json) || `request failed (${res.status})`,
        });
        setLastRun({
          triggered_at: new Date().toISOString(),
          ok: false,
          duration_ms: null,
          result: json,
          error_message:
            (json as { error?: string })?.error ?? `request failed (${res.status})`,
        });
        return;
      }
      setState({ kind: "ok", message: formatResult(json) });
      setLastRun({
        triggered_at: new Date().toISOString(),
        ok: true,
        duration_ms: null,
        result: json,
        error_message: null,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setState({ kind: "error", message });
      setLastRun({
        triggered_at: new Date().toISOString(),
        ok: false,
        duration_ms: null,
        result: null,
        error_message: message,
      });
    }
  }

  const busy = state.kind === "running";
  const summary = lastRun ? summarizeResult(actionKey, lastRun) : null;

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
      <div className="text-body font-medium text-moonbeem-ink">{title}</div>
      <p className="mt-1 text-caption text-moonbeem-ink-subtle">
        {description}
      </p>

      {lastRun ? (
        <div className="mt-3 flex flex-col gap-0.5">
          <div className="flex items-center gap-2 text-caption text-moonbeem-ink-subtle">
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                lastRun.ok ? "bg-emerald-400" : "bg-moonbeem-magenta"
              }`}
              aria-hidden="true"
            />
            <span>
              Last run {formatRelative(lastRun.triggered_at)}
              {lastRun.duration_ms !== null
                ? ` · ${(lastRun.duration_ms / 1000).toFixed(1)}s`
                : ""}
            </span>
          </div>
          <div
            className={`text-caption tabular-nums ${
              lastRun.ok ? "text-moonbeem-ink-muted" : "text-moonbeem-magenta"
            }`}
          >
            {summary}
          </div>
        </div>
      ) : (
        <div className="mt-3 text-caption text-moonbeem-ink-subtle">
          Never run.
        </div>
      )}

      <button
        type="button"
        onClick={run}
        disabled={busy}
        className="mt-4 rounded-md bg-moonbeem-pink px-4 py-2 text-body-sm font-semibold text-moonbeem-navy hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? "Running…" : cta}
      </button>
      {state.kind === "ok" && (
        <pre className="mt-3 max-h-60 overflow-auto rounded-md border border-emerald-500/30 bg-black/40 p-3 font-mono text-caption text-emerald-200">
          {state.message}
        </pre>
      )}
      {state.kind === "error" && (
        <pre className="mt-3 max-h-60 overflow-auto rounded-md border border-moonbeem-magenta/40 bg-black/40 p-3 font-mono text-caption text-moonbeem-magenta">
          {state.message}
        </pre>
      )}
    </div>
  );
}

function snapshotFromRun(run: AdminActionRun | undefined): LastRunSnapshot | null {
  if (!run) return null;
  return {
    triggered_at: run.triggered_at,
    ok: run.ok,
    duration_ms: run.duration_ms,
    result: run.result,
    error_message: run.error_message,
  };
}

export default function AdminQuickActions({
  lastRuns,
  openRequestCount,
}: {
  lastRuns: Partial<Record<AdminActionKey, AdminActionRun>>;
  // Open title requests across all partners (rows in title_requests
  // for titles with no published fan_edits yet). Displayed on the
  // stacked Title requests nav card with pluralization-aware copy.
  openRequestCount: number;
}) {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
      <ActionCard
        actionKey="earnings_calculate"
        title="Trigger earnings calculation"
        description="Runs the daily CPM calc across active partner_title_rates. Idempotent — safe to re-run."
        endpoint="/api/admin/earnings/calculate"
        cta="Run earnings calc"
        initialLastRun={snapshotFromRun(lastRuns.earnings_calculate)}
      />
      <ActionCard
        actionKey="view_tracking_trigger"
        title="Trigger view tracking"
        description="Forces a refresh tick of the view-tracking Edge Function. Same-UTC-day short-circuit applies."
        endpoint="/api/admin/view-tracking/trigger"
        cta="Run view tracking"
        initialLastRun={snapshotFromRun(lastRuns.view_tracking_trigger)}
      />
      {/* Third column: stacked navigation cards. The two action cards
          on the left are tall (title + multi-line desc + button + last-
          run state); splitting column 3 into two slim cards (View click
          events + Title requests) gives Title requests card-level weight
          while keeping the row's total height balanced. */}
      <div className="flex flex-col gap-4">
        <NavCard
          href="/admin/clicks"
          title="View click events"
          description="Bot filtering, top titles, top creators"
          cta="Open All Clicks →"
        />
        <NavCard
          href="/admin/requests"
          title="Title requests"
          description={`${openRequestCount} open ${
            openRequestCount === 1 ? "request" : "requests"
          } across all partners`}
          cta="View all →"
        />
      </div>
    </div>
  );
}

// Slim navigation card — half the height of an ActionCard, used for
// the stacked third column on the /admin Quick actions row. Tighter
// padding (p-4) and pill (px-3 py-1.5) so two stack inside the same
// total height as one ActionCard.
function NavCard({
  href,
  title,
  description,
  cta,
}: {
  href: string;
  title: string;
  description: string;
  cta: string;
}) {
  return (
    <Link
      href={href}
      className="flex flex-col rounded-2xl border border-white/10 bg-white/[0.02] p-4 transition-colors hover:border-moonbeem-pink/40"
    >
      <div className="text-body-sm font-medium text-moonbeem-ink">
        {title}
      </div>
      <p className="mt-1 text-caption text-moonbeem-ink-subtle">
        {description}
      </p>
      <span className="mt-3 inline-block w-fit rounded-md border border-white/15 px-3 py-1.5 text-caption text-moonbeem-ink">
        {cta}
      </span>
    </Link>
  );
}
