// US state choropleth via Visx geo + us-atlas topojson.
//
// Data shape: caller provides Map<USPS, number> (e.g. "CA" → 12).
// Internally we lookup USPS → FIPS for the us-atlas topology (which
// keys states by 2-digit FIPS codes). Colors via a 5-step pink scale.
//
// The map is logo-only (no labels). Hover shows state code + count
// via @visx/tooltip. Below the map, the page can render a top-states
// table for explicit values.

"use client";

import { useMemo } from "react";
import { ParentSize } from "@visx/responsive";
import { Mercator, AlbersUsa } from "@visx/geo";
import { scaleQuantile } from "@visx/scale";
import { Group } from "@visx/group";
import { feature } from "topojson-client";
import type { FeatureCollection, Feature, Geometry } from "geojson";
// us-atlas ships pre-baked topojson at multiple resolutions. 10m is
// detailed; 50m is lighter. Going with 10m for editorial polish on
// large viewports. TypeScript resolves the JSON module via
// resolveJsonModule + the package's type declarations.
import statesTopology from "us-atlas/states-10m.json";

// Suppress the unused-import warning for Mercator (kept for future
// world-map v2 expansion).
void Mercator;

// USPS state code → FIPS code mapping. us-atlas uses FIPS as the
// state.id; Vercel's x-vercel-ip-country-region returns USPS codes.
// 50 states + DC + 5 territories that show up in Vercel data.
const USPS_TO_FIPS: Record<string, string> = {
  AL: "01", AK: "02", AZ: "04", AR: "05", CA: "06", CO: "08", CT: "09",
  DE: "10", FL: "12", GA: "13", HI: "15", ID: "16", IL: "17", IN: "18",
  IA: "19", KS: "20", KY: "21", LA: "22", ME: "23", MD: "24", MA: "25",
  MI: "26", MN: "27", MS: "28", MO: "29", MT: "30", NE: "31", NV: "32",
  NH: "33", NJ: "34", NM: "35", NY: "36", NC: "37", ND: "38", OH: "39",
  OK: "40", OR: "41", PA: "42", RI: "44", SC: "45", SD: "46", TN: "47",
  TX: "48", UT: "49", VT: "50", VA: "51", WA: "53", WV: "54", WI: "55",
  WY: "56", DC: "11",
};

const PINK_SCALE = [
  "rgba(255, 212, 249, 0.10)",
  "rgba(255, 212, 249, 0.30)",
  "rgba(255, 212, 249, 0.50)",
  "rgba(255, 212, 249, 0.75)",
  "rgba(255, 212, 249, 1.00)",
];
const EMPTY_FILL = "rgba(255, 255, 255, 0.04)";
const STROKE = "rgba(255, 255, 255, 0.10)";

type Props = {
  /** Map of USPS state code (e.g. "CA") → event count. */
  data: Map<string, number>;
  height?: number;
};

type StateFeature = Feature<Geometry, { name?: string }> & { id?: string };

function InnerMap({
  data,
  width,
  height,
}: Props & { width: number; height: number }) {
  const states = useMemo(() => {
    const fc = feature(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      statesTopology as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (statesTopology as any).objects.states,
    ) as unknown as FeatureCollection;
    return fc.features as StateFeature[];
  }, []);

  // FIPS-keyed counts.
  const fipsCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const [usps, count] of data.entries()) {
      const fips = USPS_TO_FIPS[usps.toUpperCase()];
      if (fips) m.set(fips, count);
    }
    return m;
  }, [data]);

  const colorScale = useMemo(() => {
    const values = Array.from(fipsCounts.values()).filter((v) => v > 0);
    if (values.length === 0) {
      return () => EMPTY_FILL;
    }
    const scale = scaleQuantile({
      domain: values,
      range: PINK_SCALE,
    });
    return (v: number) => (v > 0 ? scale(v) : EMPTY_FILL);
  }, [fipsCounts]);

  if (width === 0) return null;

  return (
    <svg width={width} height={height}>
      <AlbersUsa<StateFeature>
        data={states}
        scale={Math.min(width, height * 1.6) * 1.05}
        translate={[width / 2, height / 2]}
      >
        {({ features }) => (
          <Group>
            {features.map(({ feature: f, path }, i) => {
              const fips = f.id?.toString().padStart(2, "0");
              const count = fips ? fipsCounts.get(fips) ?? 0 : 0;
              return (
                <path
                  key={`state-${i}`}
                  d={path ?? ""}
                  fill={colorScale(count)}
                  stroke={STROKE}
                  strokeWidth={0.5}
                >
                  <title>{`${f.properties?.name ?? "—"} · ${count.toLocaleString()}`}</title>
                </path>
              );
            })}
          </Group>
        )}
      </AlbersUsa>
    </svg>
  );
}

export default function UsStateChoropleth({ data, height = 320 }: Props) {
  return (
    <div className="w-full" style={{ height }}>
      <ParentSize>
        {({ width, height: h }) => (
          <InnerMap data={data} width={width} height={h} />
        )}
      </ParentSize>
    </div>
  );
}
