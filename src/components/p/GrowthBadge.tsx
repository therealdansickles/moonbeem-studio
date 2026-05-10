// Inline 24h growth label used by the Top Performers card and any
// future surface that wants a +/- delta + percentage in one pill.
// Server-renderable — pure presentation, no client state.

import { formatMetric } from "@/lib/format";

type Props = {
  delta: number | null;
  pct: number | null;
};

export default function GrowthBadge({ delta, pct }: Props) {
  if (delta === null) {
    return (
      <span className="text-caption text-moonbeem-ink-subtle tabular-nums">
        —
      </span>
    );
  }
  const positive = delta >= 0;
  const sign = positive ? "+" : "";
  const pctTxt = pct !== null
    ? ` (${pct >= 0 ? "+" : ""}${pct.toFixed(pct >= 10 || pct <= -10 ? 0 : 1)}%)`
    : "";
  return (
    <span
      className={`text-caption tabular-nums ${
        positive ? "text-emerald-300" : "text-moonbeem-magenta"
      }`}
    >
      {sign}
      {formatMetric(Math.abs(delta))}
      {pctTxt}
    </span>
  );
}
