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

import { getMuxData } from "@/lib/mux";

// Retention-bounded window. ⚠️ NOT "lifetime": Mux Data is not a lifetime store,
// so this is explicitly a windowed number and the tiles must say so — unlike the
// fan-edit tiles, which sum our own DB and are genuinely lifetime.
export const MUX_VIEW_WINDOW = "90:days";

export type MuxViewMetrics = {
  film_views: number;
  // Milliseconds, as Mux Data reports total_watch_time. ⚠️ The ms unit is a
  // vendor assumption VERIFIED AT ACCEPTANCE against the Mux dashboard's hours
  // figure (formatWatchHours below), not asserted blind.
  watch_time_ms: number;
};

type PerTitleResult =
  | { ok: true; views: number; watch_time_ms: number }
  | { ok: false };

// PURE: fold per-title results into one aggregate, or null if ANY failed. Pure so
// the degrade-not-undercount rule is directly unit-testable without hitting Mux.
export function aggregateMuxViewMetrics(
  results: PerTitleResult[],
): MuxViewMetrics | null {
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

// IMPURE: the per-title Mux Data loop. Returns the aggregate, or null when
// DEGRADED (any title failed, OR the Data client is unconfigured, OR Mux is down).
// Can only RESOLVE — every failure path returns null, so it never rejects and can
// safely sit inside the dashboard's Promise.all without being able to break it.
export async function loadMuxViewMetrics(
  titleIds: string[],
): Promise<MuxViewMetrics | null> {
  // Empty catalog: a real zero, not a Mux call (mirrors the sibling helpers'
  // titleIds.length === 0 guard).
  if (titleIds.length === 0) return { film_views: 0, watch_time_ms: 0 };

  let mux: ReturnType<typeof getMuxData>;
  try {
    mux = getMuxData(); // throws if MUX_DATA_TOKEN_* unset (preview/local) -> degrade
  } catch {
    return null;
  }

  const settled = await Promise.allSettled(
    titleIds.map((id) =>
      mux.data.metrics.getOverallValues("views", {
        timeframe: [MUX_VIEW_WINDOW],
        // custom_2 = title_id (the join key from C4); ONE value per call (option
        // B). !custom_3:preview excludes owner previews (mandatory).
        filters: [`custom_2:${id}`, "!custom_3:preview"],
      }),
    ),
  );

  const results: PerTitleResult[] = settled.map((s) =>
    s.status === "fulfilled"
      ? {
          ok: true,
          views: s.value.data.total_views ?? 0,
          watch_time_ms: s.value.data.total_watch_time ?? 0,
        }
      : { ok: false },
  );

  return aggregateMuxViewMetrics(results);
}
