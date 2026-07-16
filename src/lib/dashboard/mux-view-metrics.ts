// Partner-dashboard per-title Mux Data view metrics (Phase 1). TELEMETRY
// REPORTING — no money, no per-viewer identity.
//
// ── TENANCY: THE titleIds ARRAY IS THE WHOLE BOUNDARY ────────────────────────
// loadMuxViewMetrics takes the SAME titleIds array the dashboard already built at
// page.tsx (titleRows.map(t => t.id), seeded by `titles WHERE partner_id = ... `).
// It NEVER re-derives from partner.id, NEVER accepts a slug, NEVER queries titles
// itself. One derivation, inherited — a second derivation would be a second place
// the tenant scope could drift.
//
// ── OPTION B (per-title loop), by ruling ─────────────────────────────────────
// One Mux call per title, each filtered to exactly ONE of our title_ids, so Mux
// never hands us another partner's rows. The rejected alternative (group_by
// custom_2 across the whole Mux environment, then filter in our code) pulls every
// partner's data into our process and trusts a hand filter to drop it — the exact
// no-backstop pattern we are avoiding. Not-fetching beats fetching-and-discarding.
// (Scaling note: at large catalogs this is N calls; a paginated breakdown would
// replace it — but that reintroduces the over-fetch, so it waits for a real need.)
//
// ── !custom_3:preview IS MANDATORY ───────────────────────────────────────────
// custom_3="preview" marks OWNER previews (a filmmaker scrubbing their own upload,
// C4). They are NOT audience. Omitting the exclusion lets a creator inflate their
// own view count — the C4 fabricated-statistic risk arriving through the reporting
// layer. Every partner-facing view/watch-time query carries this filter.
//
// ── DEGRADE, NEVER UNDERCOUNT ────────────────────────────────────────────────
// The aggregate is a SUM across titles. If ONE title's call fails, a partial sum
// is a WRONG number, and on a partner-reporting surface a wrong number is worse
// than no number. So any per-title failure poisons the whole aggregate to null
// (the tile renders "temporarily unavailable"), never a silent short sum.
//
// Per-title failures ARE reported (console + Sentry: title_id, HTTP status, Mux
// error type — never token values) so a degraded tile is diagnosable from logs
// instead of a local replay. Reporting is visibility only; it never changes the
// degrade rule above. The unset-token degrade (getMuxData throws in local/
// preview) stays deliberately silent — that path is expected, not a failure.

import * as Sentry from "@sentry/nextjs";

import { getMuxData } from "@/lib/mux";
import type { TimeWindow } from "./queries";

// ── RETENTION + EPOCH (Phase 2) ──────────────────────────────────────────────
// Mux Data is NOT a lifetime store — it has a ROLLING retention ceiling (~100d
// on this account; probed 2026-07-16, Mux 400s `invalid_timeframe` beyond it and
// echoes the exact valid start). We floor every request at MUX_MAX_LOOKBACK_DAYS,
// conservatively INSIDE that ceiling, so we never knowingly exceed it. Separately,
// custom_2 tagging only began at MUX_TAGGING_EPOCH (commit 537cd72, 2026-07-14):
// there is NO tagged film-view datum before it, so the since-date label is floored
// at the epoch and a Mux "all" window means "since the epoch", never lifetime.
export const MUX_TAGGING_EPOCH = "2026-07-14T00:00:00Z";
export const MUX_MAX_LOOKBACK_DAYS = 90;

const DAY_SEC = 86_400;

// Aggregate shape (pure, unit-tested). Milliseconds for watch time, as Mux
// reports total_watch_time — ⚠️ a vendor assumption VERIFIED AT ACCEPTANCE
// against the Mux dashboard's hours figure (formatWatchHours), not asserted blind.
type MuxViewAggregate = { film_views: number; watch_time_ms: number };
// What loadMuxViewMetrics returns: the aggregate plus the epoch-honest since-date
// (YYYY-MM-DD) the tile labels itself with.
export type MuxViewMetrics = MuxViewAggregate & { since_iso: string };

type PerTitleResult =
  | { ok: true; views: number; watch_time_ms: number }
  | { ok: false };

// PURE: map a dashboard window to an ABSOLUTE Mux timeframe [start,end] (epoch-
// second STRINGS — the SDK request type is Array<string>; Mux accepts epoch
// strings) plus the epoch-honest since-date. queryStart is floored at retention
// (so we never request past the ceiling); sinceIso is additionally floored at the
// tagging epoch (no custom_2 datum exists before it). "all" maps to the epoch,
// NOT lifetime. Note: a 24h window whose start is AFTER the epoch honestly shows
// its own start (e.g. "since Jul 15"), not the epoch — max(queryStart, epoch).
export function muxWindowTimeframe(
  window: TimeWindow,
  nowMs: number,
): { timeframe: [string, string]; sinceIso: string } {
  const nowSec = Math.floor(nowMs / 1000);
  const epochSec = Math.floor(Date.parse(MUX_TAGGING_EPOCH) / 1000);
  const retentionStartSec = nowSec - MUX_MAX_LOOKBACK_DAYS * DAY_SEC;
  const desiredStartSec =
    window === "24h" ? nowSec - 1 * DAY_SEC
    : window === "7d" ? nowSec - 7 * DAY_SEC
    : window === "30d" ? nowSec - 30 * DAY_SEC
    : epochSec; // "all" → the epoch (Mux is retention-bounded, not lifetime)
  const queryStartSec = Math.max(desiredStartSec, retentionStartSec);
  const sinceSec = Math.max(queryStartSec, epochSec);
  return {
    timeframe: [String(queryStartSec), String(nowSec)],
    sinceIso: new Date(sinceSec * 1000).toISOString().slice(0, 10),
  };
}

// PURE: fold per-title results into one aggregate, or null if ANY failed. Pure so
// the degrade-not-undercount rule is directly unit-testable without hitting Mux.
export function aggregateMuxViewMetrics(
  results: PerTitleResult[],
): MuxViewAggregate | null {
  let film_views = 0;
  let watch_time_ms = 0;
  for (const r of results) {
    if (!r.ok) return null; // one failure poisons the aggregate
    film_views += r.views;
    watch_time_ms += r.watch_time_ms;
  }
  return { film_views, watch_time_ms };
}

// Format Mux watch-time (ms) as a human hours string for the tile. Kept next to
// the ms field so the unit assumption and its display live together.
export function formatWatchHours(ms: number): string {
  const hours = ms / 3_600_000;
  if (hours >= 10) return `${Math.round(hours).toLocaleString()} h`;
  return `${hours.toFixed(1)} h`;
}

// Shape a per-title rejection for reporting. The Mux SDK's APIError carries
// `status` (HTTP) and `error` (the parsed JSON body, whose Mux shape is
// {error: {type, messages}}); connection failures have neither. Extracted
// defensively from `unknown` so a shape drift in the SDK degrades the LABEL
// ("network"/"unknown"), never throws inside the reporting path.
function describeMuxFailure(reason: unknown): {
  status: number | "network";
  error_type: string;
} {
  const r = reason as { status?: unknown; error?: unknown } | null;
  const status = typeof r?.status === "number" ? r.status : "network";
  const body = r?.error as { error?: { type?: unknown } } | null | undefined;
  const error_type =
    typeof body?.error?.type === "string" ? body.error.type : "unknown";
  return { status, error_type };
}

// Report one per-title failure: structured console line + Sentry capture with
// the same fields. NEVER logs token values — only the title_id, the HTTP
// status, and Mux's error type string. (captureException sends the error's
// message/stack; Mux API error messages carry the response body, which holds
// no credentials — the auth header lives on the request, not the error.)
function reportMuxFailure(titleId: string, reason: unknown): void {
  const { status, error_type } = describeMuxFailure(reason);
  console.error(
    `[mux-view-metrics] per-title views call failed title_id=${titleId} status=${status} mux_error_type=${error_type}`,
  );
  Sentry.captureException(reason, {
    tags: { surface: "mux-view-metrics" },
    extra: { title_id: titleId, status, mux_error_type: error_type },
  });
}

// Parse Mux's echoed valid window from an `invalid_timeframe` error (the only
// error we self-heal). The SDK APIError carries `.error` = the parsed body
// `{ error: { type, valid_timeframe, messages } }`; valid_timeframe is [start,end]
// epoch NUMBERS (response shape), stringified for the retry request. Any other
// error, or a shape mismatch, returns null → no retry.
function invalidTimeframeValidWindow(
  reason: unknown,
): [string, string] | null {
  const r = reason as
    | { error?: { error?: { type?: unknown; valid_timeframe?: unknown } } }
    | null;
  const inner = r?.error?.error;
  if (inner?.type !== "invalid_timeframe") return null;
  const vt = inner.valid_timeframe;
  if (
    Array.isArray(vt) &&
    vt.length === 2 &&
    typeof vt[0] === "number" &&
    typeof vt[1] === "number"
  ) {
    return [String(vt[0]), String(vt[1])];
  }
  return null;
}

// One per-title Mux call over the absolute timeframe. RETENTION SELF-HEAL: if the
// call rejects SPECIFICALLY with `invalid_timeframe` (we requested past the
// ceiling), retry that ONE call ONCE clamped to the valid window Mux echoed. Any
// other rejection, or a failed retry, degrades this title (reported + ok:false).
// Never throws.
async function fetchTitleViews(
  mux: ReturnType<typeof getMuxData>,
  id: string,
  timeframe: [string, string],
): Promise<PerTitleResult> {
  const call = (tf: [string, string]) =>
    mux.data.metrics.getOverallValues("views", {
      timeframe: tf,
      // custom_2 = title_id (the C4 join key); ONE value per call (option B).
      // !custom_3:preview excludes owner previews (mandatory).
      filters: [`custom_2:${id}`, "!custom_3:preview"],
    });
  try {
    const v = await call(timeframe);
    return {
      ok: true,
      views: v.data.total_views ?? 0,
      watch_time_ms: v.data.total_watch_time ?? 0,
    };
  } catch (err) {
    const valid = invalidTimeframeValidWindow(err);
    if (valid) {
      try {
        const v = await call(valid);
        return {
          ok: true,
          views: v.data.total_views ?? 0,
          watch_time_ms: v.data.total_watch_time ?? 0,
        };
      } catch (retryErr) {
        reportMuxFailure(id, retryErr);
        return { ok: false };
      }
    }
    reportMuxFailure(id, err);
    return { ok: false };
  }
}

// IMPURE: the per-title Mux Data loop over an ABSOLUTE, retention-floored window.
// Returns the aggregate + since-date, or null when DEGRADED (any title failed,
// OR the Data client is unconfigured, OR Mux is down). Can only RESOLVE — every
// failure path returns null, so it never rejects inside the dashboard's
// Promise.all. (Sentry.captureException never throws; a Sentry outage can't break
// the loop.) titleIds is a SUBSET of the one gated derivation (all, or a single
// selected title) — the tenant boundary is unchanged.
export async function loadMuxViewMetrics(
  titleIds: string[],
  window: TimeWindow,
): Promise<MuxViewMetrics | null> {
  const { timeframe, sinceIso } = muxWindowTimeframe(window, Date.now());
  // Empty selection/catalog: a real zero, not a Mux call.
  if (titleIds.length === 0) {
    return { film_views: 0, watch_time_ms: 0, since_iso: sinceIso };
  }

  let mux: ReturnType<typeof getMuxData>;
  try {
    mux = getMuxData(); // throws if MUX_DATA_TOKEN_* unset (preview/local) -> degrade
  } catch {
    return null;
  }

  const results = await Promise.all(
    titleIds.map((id) => fetchTitleViews(mux, id, timeframe)),
  );
  const agg = aggregateMuxViewMetrics(results);
  return agg ? { ...agg, since_iso: sinceIso } : null;
}
