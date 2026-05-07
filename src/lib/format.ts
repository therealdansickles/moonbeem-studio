// Compact-format a metric: 1234 → "1.2K", 1200000 → "1.2M".
// Used across partner dashboard surfaces.
export function formatMetric(n: number): string {
  if (n < 1000) return n.toLocaleString();
  if (n < 1_000_000) {
    const k = n / 1000;
    return `${k % 1 === 0 ? k.toFixed(0) : k.toFixed(1)}K`;
  }
  const m = n / 1_000_000;
  return `${m % 1 === 0 ? m.toFixed(0) : m.toFixed(1)}M`;
}

const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

// "2026-05-07" → "May 7"
export function formatDayShort(day: string): string {
  const parts = day.split("-");
  if (parts.length !== 3) return day;
  const month = MONTH_NAMES[parseInt(parts[1], 10) - 1] ?? parts[1];
  return `${month} ${parseInt(parts[2], 10)}`;
}
