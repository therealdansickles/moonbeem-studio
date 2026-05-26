// Responsive time-series chart for dashboard event-rate panels.
// Visx primitives: scaleTime + scaleLinear for axes, LinePath for the
// trend line, AreaClosed for the fill, AxisBottom/Left for the
// editorial axis labels.
//
// Brand color: moonbeem-pink line + 12% pink fill. Axes use
// ink-subtle. tabular-nums on tick labels for the editorial-precise
// feel.
//
// No hover tooltip today — the chart is decorative trend at this
// surface and detailed numbers live in the tables below. Adding a
// nearest-point tooltip via @visx/tooltip is tracked separately.

"use client";

import { useMemo } from "react";
import { ParentSize } from "@visx/responsive";
import { scaleTime, scaleLinear } from "@visx/scale";
import { AxisBottom, AxisLeft } from "@visx/axis";
import { LinePath, AreaClosed } from "@visx/shape";
import { Group } from "@visx/group";
import { GridRows } from "@visx/grid";
import { curveMonotoneX } from "@visx/curve";

export type TimeSeriesPoint = {
  /** YYYY-MM-DD or ISO; converted to Date internally. */
  date: string;
  value: number;
};

type Props = {
  data: TimeSeriesPoint[];
  height?: number;
  /** Y-axis label, e.g. "events". Optional. */
  yLabel?: string;
};

const MARGIN = { top: 16, right: 20, bottom: 32, left: 44 };

const PINK = "#ffd4f9";
const PINK_FILL = "rgba(255, 212, 249, 0.10)";
const INK_SUBTLE = "rgba(255, 255, 255, 0.3)";
const GRID = "rgba(255, 255, 255, 0.06)";

function InnerChart({
  data,
  width,
  height,
  yLabel,
}: Props & { width: number; height: number }) {
  const innerWidth = Math.max(width - MARGIN.left - MARGIN.right, 0);
  const innerHeight = Math.max(height - MARGIN.top - MARGIN.bottom, 0);

  const parsed = useMemo(
    () =>
      data.map((p) => ({
        date: new Date(p.date),
        value: p.value,
      })),
    [data],
  );

  const xScale = useMemo(() => {
    const dates = parsed.map((p) => p.date);
    const min = dates.length > 0 ? dates[0] : new Date();
    const max = dates.length > 0 ? dates[dates.length - 1] : new Date();
    return scaleTime({
      range: [0, innerWidth],
      domain: [min, max],
    });
  }, [parsed, innerWidth]);

  const yScale = useMemo(() => {
    const maxVal = Math.max(1, ...parsed.map((p) => p.value));
    return scaleLinear({
      range: [innerHeight, 0],
      domain: [0, maxVal],
      nice: true,
    });
  }, [parsed, innerHeight]);

  if (width === 0 || height === 0) return null;

  return (
    <svg width={width} height={height}>
      <Group left={MARGIN.left} top={MARGIN.top}>
        <GridRows
          scale={yScale}
          width={innerWidth}
          stroke={GRID}
          strokeWidth={1}
          numTicks={4}
        />
        <AreaClosed<{ date: Date; value: number }>
          data={parsed}
          x={(d) => xScale(d.date) ?? 0}
          y={(d) => yScale(d.value) ?? 0}
          yScale={yScale}
          fill={PINK_FILL}
          curve={curveMonotoneX}
        />
        <LinePath<{ date: Date; value: number }>
          data={parsed}
          x={(d) => xScale(d.date) ?? 0}
          y={(d) => yScale(d.value) ?? 0}
          stroke={PINK}
          strokeWidth={1.5}
          curve={curveMonotoneX}
        />
        <AxisBottom
          top={innerHeight}
          scale={xScale}
          stroke={INK_SUBTLE}
          tickStroke={INK_SUBTLE}
          tickLabelProps={{
            fill: INK_SUBTLE,
            fontSize: 11,
            textAnchor: "middle",
          }}
          numTicks={Math.min(7, parsed.length)}
        />
        <AxisLeft
          scale={yScale}
          stroke={INK_SUBTLE}
          tickStroke={INK_SUBTLE}
          tickLabelProps={{
            fill: INK_SUBTLE,
            fontSize: 11,
            textAnchor: "end",
            dy: "0.33em",
            dx: "-0.25em",
          }}
          numTicks={4}
          label={yLabel}
          labelProps={{
            fill: INK_SUBTLE,
            fontSize: 11,
            textAnchor: "middle",
          }}
        />
      </Group>
    </svg>
  );
}

export default function TimeSeriesChart({
  data,
  height = 220,
  yLabel,
}: Props) {
  return (
    <div className="w-full" style={{ height }}>
      <ParentSize>
        {({ width, height: h }) => (
          <InnerChart data={data} width={width} height={h} yLabel={yLabel} />
        )}
      </ParentSize>
    </div>
  );
}
