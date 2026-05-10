"use client";

import { useMemo, useState } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatDayShort, formatMetric } from "@/lib/format";

// Datum is the full per-day record from the server-side loader.
// Deltas are pre-computed so the tooltip never re-derives by looking
// back into the array.
type Datum = {
  day: string;
  views: number;
  edit_count: number;
  views_delta: number | null;
  edit_count_delta: number | null;
};

type Props = {
  data: Datum[];
};

type Period = "1D" | "1W" | "1M" | "All";

const PERIODS: ReadonlyArray<Period> = ["1D", "1W", "1M", "All"];

// Days kept from the tail of the full series per period. 1D = last 1
// day = single dot. 'All' = full series untouched.
function sliceForPeriod(data: Datum[], period: Period): Datum[] {
  if (period === "All") return data;
  const n = period === "1D" ? 1 : period === "1W" ? 7 : 30;
  return data.length <= n ? data : data.slice(-n);
}

// Tooltip — recharts 3.x types the prop loosely so we runtime-guard.
// Renders both view + edit-count values with +/- delta from the prior
// day. First-day deltas come through as null and render as em-dashes.
function ChartTooltip(props: {
  active?: boolean;
  payload?: Array<{ payload?: Datum }>;
}) {
  if (!props.active || !props.payload || props.payload.length === 0) {
    return null;
  }
  const datum = props.payload[0]?.payload;
  if (!datum) return null;
  return (
    <div className="rounded-lg border border-moonbeem-violet/40 bg-moonbeem-black/95 px-3 py-2 shadow-xl shadow-black/40 backdrop-blur-md">
      <div className="text-caption text-moonbeem-ink-subtle">
        {formatDayShort(datum.day)}
      </div>
      <div className="mt-1 flex flex-col gap-0.5">
        <span className="text-body-sm font-semibold text-moonbeem-ink tabular-nums">
          {datum.views.toLocaleString()} views
          <DeltaPill delta={datum.views_delta} />
        </span>
        <span className="text-caption text-teal-300 tabular-nums">
          {datum.edit_count.toLocaleString()}{" "}
          {datum.edit_count === 1 ? "edit" : "edits"}
          <DeltaPill delta={datum.edit_count_delta} subtle />
        </span>
      </div>
    </div>
  );
}

function DeltaPill({
  delta,
  subtle,
}: {
  delta: number | null;
  subtle?: boolean;
}) {
  if (delta === null) {
    return (
      <span
        className={`ml-1.5 text-caption tabular-nums ${
          subtle ? "text-moonbeem-ink-subtle/70" : "text-moonbeem-ink-subtle"
        }`}
      >
        —
      </span>
    );
  }
  if (delta === 0) {
    return (
      <span
        className={`ml-1.5 text-caption tabular-nums ${
          subtle ? "text-moonbeem-ink-subtle/70" : "text-moonbeem-ink-subtle"
        }`}
      >
        +0
      </span>
    );
  }
  const sign = delta > 0 ? "+" : "−";
  const colorClass = delta > 0
    ? subtle ? "text-emerald-300/80" : "text-emerald-300"
    : subtle ? "text-moonbeem-magenta/80" : "text-moonbeem-magenta";
  return (
    <span className={`ml-1.5 text-caption tabular-nums ${colorClass}`}>
      {sign}
      {formatMetric(Math.abs(delta))}
    </span>
  );
}

export default function GrowthChart({ data }: Props) {
  const [period, setPeriod] = useState<Period>("All");
  const filtered = useMemo(() => sliceForPeriod(data, period), [data, period]);

  if (data.length === 0) {
    return (
      <div className="flex h-[280px] items-center justify-center text-body-sm text-moonbeem-ink-subtle">
        Not enough snapshot history yet.
      </div>
    );
  }

  return (
    <div className="w-full">
      {/* Period pills, top-right alignment matches the chart-card
          title (rendered by the parent). */}
      <div className="mb-3 flex justify-end gap-1">
        {PERIODS.map((p) => {
          const active = p === period;
          return (
            <button
              key={p}
              type="button"
              onClick={() => setPeriod(p)}
              className={
                "min-h-7 rounded-full px-2.5 py-0.5 text-caption font-medium tabular-nums transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-moonbeem-pink " +
                (active
                  ? "bg-moonbeem-pink text-moonbeem-navy"
                  : "text-moonbeem-ink-subtle hover:text-moonbeem-ink")
              }
              aria-pressed={active}
            >
              {p}
            </button>
          );
        })}
      </div>

      <div className="h-[280px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            // key forces recharts to re-mount on period change so the
            // initial-render ease-in animation runs again. Cheap and
            // gives the period change a satisfying visual transition.
            key={period}
            data={filtered}
            margin={{ top: 12, right: 12, left: 0, bottom: 0 }}
          >
            <defs>
              <linearGradient id="growthFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#ec4899" stopOpacity={0.42} />
                <stop offset="100%" stopColor="#ec4899" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="growthStroke" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor="#7c3aed" />
                <stop offset="100%" stopColor="#ec4899" />
              </linearGradient>
            </defs>

            <CartesianGrid
              stroke="rgba(255,255,255,0.06)"
              strokeDasharray="3 3"
              vertical={false}
            />

            <XAxis
              dataKey="day"
              tickFormatter={formatDayShort}
              stroke="rgba(255,255,255,0.45)"
              tick={{ fill: "rgba(255,255,255,0.7)", fontSize: 12 }}
              tickLine={false}
              axisLine={{ stroke: "rgba(255,255,255,0.1)" }}
            />
            <YAxis
              yAxisId="views"
              tickFormatter={(v: number) => formatMetric(v)}
              stroke="rgba(255,255,255,0.45)"
              tick={{ fill: "rgba(255,255,255,0.7)", fontSize: 12 }}
              tickLine={false}
              axisLine={false}
              width={56}
            />
            <YAxis
              yAxisId="edits"
              orientation="right"
              tickFormatter={(v: number) => `${v}`}
              stroke="rgba(20,184,166,0.5)"
              tick={{ fill: "rgba(20,184,166,0.75)", fontSize: 12 }}
              tickLine={false}
              axisLine={false}
              width={40}
              allowDecimals={false}
            />

            <Tooltip
              content={<ChartTooltip />}
              cursor={{ stroke: "rgba(255,212,249,0.4)", strokeWidth: 1 }}
            />

            <Area
              yAxisId="views"
              type="monotone"
              dataKey="views"
              stroke="none"
              fill="url(#growthFill)"
              animationDuration={550}
              animationEasing="ease-out"
            />
            <Line
              yAxisId="views"
              type="monotone"
              dataKey="views"
              stroke="url(#growthStroke)"
              strokeWidth={2.5}
              dot={{ fill: "#ec4899", stroke: "#7c3aed", strokeWidth: 1.5, r: 3 }}
              activeDot={{ r: 5, fill: "#ec4899", stroke: "#7c3aed" }}
              animationDuration={550}
              animationEasing="ease-out"
            />
            {/* Cumulative edit-count: visually subordinate (thinner
                stroke, no fill, dashed) so the views line stays the
                visual primary. Teal contrasts with the violet→pink
                stroke without competing for attention. */}
            <Line
              yAxisId="edits"
              type="monotone"
              dataKey="edit_count"
              stroke="#14b8a6"
              strokeWidth={1.5}
              strokeDasharray="4 3"
              dot={false}
              activeDot={{ r: 4, fill: "#14b8a6", stroke: "#0f766e" }}
              animationDuration={550}
              animationEasing="ease-out"
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
