"use client";

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

type Datum = {
  day: string;
  views: number;
};

type Props = {
  data: Datum[];
};

// recharts 3.x renames/restructures TooltipProps; typing this loosely
// is fine since we only read fields we can guard at runtime. Custom
// tooltip — recharts' default chrome is gray and at odds with the
// Moonbeem palette.
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
    <div className="rounded-lg border border-white/15 bg-moonbeem-black/95 px-3 py-2 shadow-xl shadow-black/40 backdrop-blur-md">
      <div className="text-caption text-moonbeem-ink-subtle">
        {formatDayShort(datum.day)}
      </div>
      <div className="text-body-sm font-semibold text-moonbeem-ink tabular-nums">
        {datum.views.toLocaleString()} views
      </div>
    </div>
  );
}

export default function GrowthChart({ data }: Props) {
  if (data.length === 0) {
    return (
      <div className="flex h-[280px] items-center justify-center text-body-sm text-moonbeem-ink-subtle">
        Not enough snapshot history yet.
      </div>
    );
  }

  return (
    <div className="h-[280px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart
          data={data}
          margin={{ top: 12, right: 12, left: 0, bottom: 0 }}
        >
          <defs>
            <linearGradient id="growthFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#ffd4f9" stopOpacity={0.35} />
              <stop offset="100%" stopColor="#ffd4f9" stopOpacity={0} />
            </linearGradient>
            <linearGradient id="growthStroke" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#7c3aed" />
              <stop offset="100%" stopColor="#ffd4f9" />
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
            tickFormatter={(v: number) => formatMetric(v)}
            stroke="rgba(255,255,255,0.45)"
            tick={{ fill: "rgba(255,255,255,0.7)", fontSize: 12 }}
            tickLine={false}
            axisLine={false}
            width={56}
          />

          <Tooltip
            content={<ChartTooltip />}
            cursor={{ stroke: "rgba(255,212,249,0.4)", strokeWidth: 1 }}
          />

          <Area
            type="monotone"
            dataKey="views"
            stroke="none"
            fill="url(#growthFill)"
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="views"
            stroke="url(#growthStroke)"
            strokeWidth={2.5}
            dot={{ fill: "#ffd4f9", stroke: "#7c3aed", strokeWidth: 1.5, r: 3 }}
            activeDot={{ r: 5, fill: "#ffd4f9", stroke: "#7c3aed" }}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
