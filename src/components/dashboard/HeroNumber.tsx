// Big editorial number tile for dashboard hero sections. Wraps the
// design-token typography (font-wordmark + text-display-*) with
// tabular-nums + brand-aligned delta colors.

type Trend = "up" | "down" | "neutral";

type Props = {
  /** Pre-formatted display string. e.g. "1,234" or "$5.0K" or "—". */
  value: string;
  /** Short uppercase-styled label below the value. */
  label: string;
  /** Optional change-since-window indicator (e.g. "+12 this week"). */
  delta?: string;
  /** Controls delta color. neutral = muted; up = lime; down = magenta. */
  trend?: Trend;
  /** xl: text-display-xl (96px). lg: text-display-lg (72px, default). */
  size?: "lg" | "xl";
};

export default function HeroNumber({
  value,
  label,
  delta,
  trend = "neutral",
  size = "lg",
}: Props) {
  const sizeClass =
    size === "xl" ? "text-display-xl" : "text-display-lg";
  const trendClass =
    trend === "up"
      ? "text-moonbeem-lime"
      : trend === "down"
      ? "text-moonbeem-magenta"
      : "text-moonbeem-ink-subtle";

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-5 flex flex-col gap-2">
      <p className="text-caption uppercase tracking-wide text-moonbeem-ink-muted m-0">
        {label}
      </p>
      <p
        className={`m-0 font-wordmark ${sizeClass} text-moonbeem-ink tabular-nums leading-[0.95]`}
      >
        {value}
      </p>
      {delta && (
        <p className={`text-body-sm m-0 tabular-nums ${trendClass}`}>
          {delta}
        </p>
      )}
    </div>
  );
}
