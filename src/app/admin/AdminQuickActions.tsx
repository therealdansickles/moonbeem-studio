"use client";

import Link from "next/link";
import { useState } from "react";

type ActionState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "ok"; message: string }
  | { kind: "error"; message: string };

function formatResult(payload: unknown): string {
  if (payload && typeof payload === "object") {
    return JSON.stringify(payload, null, 2);
  }
  return String(payload ?? "");
}

function ActionCard({
  title,
  description,
  endpoint,
  method = "POST",
  cta,
}: {
  title: string;
  description: string;
  endpoint: string;
  method?: "POST" | "GET";
  cta: string;
}) {
  const [state, setState] = useState<ActionState>({ kind: "idle" });

  async function run() {
    setState({ kind: "running" });
    try {
      const res = await fetch(endpoint, { method });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setState({
          kind: "error",
          message: formatResult(json) || `request failed (${res.status})`,
        });
        return;
      }
      setState({ kind: "ok", message: formatResult(json) });
    } catch (err) {
      setState({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const busy = state.kind === "running";

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
      <div className="text-body font-medium text-moonbeem-ink">{title}</div>
      <p className="mt-1 text-caption text-moonbeem-ink-subtle">
        {description}
      </p>
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

export default function AdminQuickActions() {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
      <ActionCard
        title="Trigger earnings calculation"
        description="Runs the daily CPM calc across active partner_title_rates. Idempotent — safe to re-run."
        endpoint="/api/admin/earnings/calculate"
        cta="Run earnings calc"
      />
      <ActionCard
        title="Trigger view tracking"
        description="Forces a refresh tick of the view-tracking Edge Function. Same-UTC-day short-circuit applies."
        endpoint="/api/admin/view-tracking/trigger"
        cta="Run view tracking"
      />
      <Link
        href="/admin/clicks"
        className="rounded-2xl border border-white/10 bg-white/[0.02] p-5 transition-colors hover:border-moonbeem-pink/40"
      >
        <div className="text-body font-medium text-moonbeem-ink">
          View click events
        </div>
        <p className="mt-1 text-caption text-moonbeem-ink-subtle">
          Last 7 / 30 day human-vs-bot rollups, top titles, top creators.
        </p>
        <span className="mt-4 inline-block rounded-md border border-white/15 px-4 py-2 text-body-sm text-moonbeem-ink">
          Open All Clicks →
        </span>
      </Link>
    </div>
  );
}
