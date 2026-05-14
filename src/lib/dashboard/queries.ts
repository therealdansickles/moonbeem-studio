// Shared query + time-window helpers used across the three dashboard
// surfaces (platform-wide, per-title, per-partner). Centralizes
// window parsing + ISO-date cutoff math so route pages stay thin.
//
// All time-windowed queries take a TimeWindow value; pass through
// windowCutoffIso() to get the .gte() bound.

export type TimeWindow = "24h" | "7d" | "30d" | "all";
export const TIME_WINDOWS: TimeWindow[] = ["24h", "7d", "30d", "all"];

export function parseWindow(raw: string | string[] | undefined): TimeWindow {
  if (typeof raw === "string" && (TIME_WINDOWS as string[]).includes(raw)) {
    return raw as TimeWindow;
  }
  return "7d";
}

export function windowCutoffIso(w: TimeWindow): string | null {
  if (w === "all") return null;
  const ms =
    w === "24h" ? 24 * 60 * 60 * 1000
    : w === "7d" ? 7 * 24 * 60 * 60 * 1000
    : 30 * 24 * 60 * 60 * 1000;
  return new Date(Date.now() - ms).toISOString();
}

export function windowLabel(w: TimeWindow): string {
  if (w === "24h") return "Last 24 hours";
  if (w === "7d") return "Last 7 days";
  if (w === "30d") return "Last 30 days";
  return "All time";
}

export function windowShortLabel(w: TimeWindow): string {
  if (w === "24h") return "24h";
  if (w === "7d") return "7d";
  if (w === "30d") return "30d";
  return "all";
}

/**
 * Builds a date-bucketed time series from a list of ISO timestamps.
 * Returns one bucket per day in the window (or all data if window=all),
 * always including zero-count days so the chart line is continuous.
 *
 * For 24h: hourly buckets (24 points).
 * For 7d/30d: daily buckets.
 * For all: daily buckets across the data's actual range.
 */
export function bucketTimeSeries(
  timestamps: string[],
  window: TimeWindow,
): { date: string; value: number }[] {
  if (timestamps.length === 0 && window === "all") return [];

  const useHourly = window === "24h";
  const bucketKey = (iso: string): string => {
    if (useHourly) return iso.slice(0, 13); // YYYY-MM-DDTHH
    return iso.slice(0, 10); // YYYY-MM-DD
  };

  const counts = new Map<string, number>();
  for (const t of timestamps) {
    const k = bucketKey(t);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }

  // Generate the full bucket sequence so empty days/hours render as zero.
  const out: { date: string; value: number }[] = [];
  if (window === "all") {
    const keys = Array.from(counts.keys()).sort();
    if (keys.length === 0) return [];
    const start = new Date(keys[0] + "T00:00:00Z").getTime();
    const end = new Date(keys[keys.length - 1] + "T00:00:00Z").getTime();
    const stepMs = 86_400_000;
    for (let t = start; t <= end; t += stepMs) {
      const k = new Date(t).toISOString().slice(0, 10);
      out.push({ date: k, value: counts.get(k) ?? 0 });
    }
    return out;
  }

  const now = Date.now();
  const windowMs =
    window === "24h" ? 24 * 60 * 60 * 1000
    : window === "7d" ? 7 * 24 * 60 * 60 * 1000
    : 30 * 24 * 60 * 60 * 1000;
  const stepMs = useHourly ? 60 * 60 * 1000 : 86_400_000;
  const start = now - windowMs;
  for (let t = start; t <= now; t += stepMs) {
    const iso = new Date(t).toISOString();
    const k = useHourly ? iso.slice(0, 13) : iso.slice(0, 10);
    out.push({ date: iso.slice(0, 10), value: counts.get(k) ?? 0 });
  }
  return out;
}

/**
 * Counts USPS state codes from a list of event rows. Returns a Map
 * keyed by USPS code (e.g. "CA"), value = event count.
 */
export function countByState(
  rows: { country_code: string | null; region_code: string | null }[],
): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) {
    if (r.country_code !== "US" || !r.region_code) continue;
    m.set(r.region_code, (m.get(r.region_code) ?? 0) + 1);
  }
  return m;
}

/**
 * Counts country codes from a list of event rows. Returns sorted
 * array of { country_code, count } pairs, descending by count.
 */
export function countByCountry(
  rows: { country_code: string | null }[],
): { country_code: string; count: number }[] {
  const m = new Map<string, number>();
  for (const r of rows) {
    if (!r.country_code) continue;
    m.set(r.country_code, (m.get(r.country_code) ?? 0) + 1);
  }
  return Array.from(m.entries())
    .map(([country_code, count]) => ({ country_code, count }))
    .sort((a, b) => b.count - a.count);
}

export type CityCount = {
  city: string;
  region_code: string | null;
  country_code: string | null;
  count: number;
  /** Display string: "Brooklyn, NY" (US) or "Toronto, CA" (non-US). */
  label: string;
};

/**
 * Aggregates rows from one or more geo-tagged sources (e.g.
 * external_clicks + fan_edit_events) into a top-N city ranking.
 * Rows without a city are dropped — they can't appear in a city
 * table by definition, but they're still counted in the country
 * totals upstream.
 *
 * Key is the (country_code, region_code, city) tuple so "Brooklyn,
 * NY, US" and "Brooklyn, IA, US" don't collide.
 */
export function countByCity(
  rows: {
    city: string | null;
    region_code: string | null;
    country_code: string | null;
  }[],
): CityCount[] {
  const m = new Map<string, CityCount>();
  for (const r of rows) {
    if (!r.city) continue;
    const key = `${r.country_code ?? ""}|${r.region_code ?? ""}|${r.city}`;
    const existing = m.get(key);
    if (existing) {
      existing.count++;
      continue;
    }
    // Prefer region_code for US (e.g. "NY"); fall back to
    // country_code for non-US since region codes are less
    // recognizable internationally.
    const tail =
      r.country_code === "US" && r.region_code
        ? r.region_code
        : r.country_code ?? r.region_code ?? null;
    const label = tail ? `${r.city}, ${tail}` : r.city;
    m.set(key, {
      city: r.city,
      region_code: r.region_code ?? null,
      country_code: r.country_code ?? null,
      count: 1,
      label,
    });
  }
  return Array.from(m.values()).sort((a, b) => b.count - a.count);
}
