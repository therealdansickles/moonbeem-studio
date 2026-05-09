"use client";

import { useMemo, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import PlatformIcon from "@/components/PlatformIcon";
import { formatMetric } from "@/lib/format";

type Row = {
  id: string;
  platform: "tiktok" | "instagram" | "twitter" | "youtube";
  thumbnail_url: string | null;
  creator_handle: string | null;
  view_count: number;
  growth_24h: number | null;
  modal_opens: number;
};

type Props = {
  rows: Row[];
  titleSlug: string;
};

type SortKey = "view_count" | "growth_24h" | "creator_handle" | "platform" | "modal_opens";
type SortDir = "asc" | "desc";

const HEADERS: Array<{ key: SortKey; label: string; align: "left" | "right" }> = [
  { key: "creator_handle", label: "Creator", align: "left" },
  { key: "platform", label: "Platform", align: "left" },
  { key: "view_count", label: "Views", align: "right" },
  { key: "growth_24h", label: "24h growth", align: "right" },
  { key: "modal_opens", label: "Moonbeem plays", align: "right" },
];

const platformLabel: Record<Row["platform"], string> = {
  tiktok: "TikTok",
  instagram: "Instagram",
  twitter: "X",
  youtube: "YouTube",
};

function compareNullable<T>(a: T | null, b: T | null, dir: SortDir): number {
  // Nulls sort to bottom regardless of direction.
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (typeof a === "number" && typeof b === "number") {
    return dir === "asc" ? a - b : b - a;
  }
  const sa = String(a);
  const sb = String(b);
  return dir === "asc" ? sa.localeCompare(sb) : sb.localeCompare(sa);
}

export default function AllEditsTable({ rows, titleSlug }: Props) {
  const [sortKey, setSortKey] = useState<SortKey>("view_count");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      // Numeric columns default to descending; alpha to ascending.
      setSortDir(
        key === "view_count" || key === "growth_24h" || key === "modal_opens"
          ? "desc"
          : "asc",
      );
    }
  }

  const sorted = useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => compareNullable(a[sortKey], b[sortKey], sortDir));
    return copy;
  }, [rows, sortKey, sortDir]);

  return (
    <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/[0.02]">
      {/* Mobile: scroll-x. Desktop: full width. */}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] border-collapse text-body-sm">
          <thead>
            <tr className="border-b border-white/10 text-left text-caption uppercase tracking-wide text-moonbeem-ink-subtle">
              <th className="px-4 py-3 font-medium">#</th>
              <th className="px-2 py-3 font-medium">Edit</th>
              {HEADERS.map((h) => (
                <th
                  key={h.key}
                  className={`px-4 py-3 font-medium ${
                    h.align === "right" ? "text-right" : "text-left"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => toggleSort(h.key)}
                    className={`inline-flex items-center gap-1 hover:text-moonbeem-ink ${
                      sortKey === h.key
                        ? "text-moonbeem-pink"
                        : "text-moonbeem-ink-subtle"
                    }`}
                  >
                    {h.label}
                    {sortKey === h.key && (
                      <span aria-hidden="true">
                        {sortDir === "desc" ? "↓" : "↑"}
                      </span>
                    )}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r, i) => (
              <tr
                key={r.id}
                className="border-b border-white/5 transition-colors hover:bg-white/[0.04]"
              >
                <td className="px-4 py-3 align-middle text-caption tabular-nums text-moonbeem-ink-subtle">
                  {i + 1}
                </td>
                <td className="px-2 py-3 align-middle">
                  <Link
                    href={`/t/${titleSlug}#fan-edits`}
                    className="relative block h-12 w-12 overflow-hidden rounded-md bg-moonbeem-navy/40"
                  >
                    {r.thumbnail_url
                      ? (
                        <Image
                          src={r.thumbnail_url}
                          alt=""
                          fill
                          sizes="48px"
                          unoptimized
                          className="object-cover"
                        />
                      )
                      : null}
                  </Link>
                </td>
                <td className="px-4 py-3 align-middle">
                  {r.creator_handle
                    ? (
                      <Link
                        href={`/c/${r.creator_handle}`}
                        className="text-moonbeem-ink hover:text-moonbeem-pink"
                      >
                        @{r.creator_handle}
                      </Link>
                    )
                    : (
                      <span className="text-moonbeem-ink-subtle">@anon</span>
                    )}
                </td>
                <td className="px-4 py-3 align-middle">
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 px-2 py-0.5 text-caption text-moonbeem-ink-muted">
                    <PlatformIcon
                      platform={r.platform}
                      className="h-3 w-3"
                    />
                    {platformLabel[r.platform]}
                  </span>
                </td>
                <td className="px-4 py-3 align-middle text-right tabular-nums text-moonbeem-ink">
                  {formatMetric(r.view_count)}
                </td>
                <td className="px-4 py-3 align-middle text-right tabular-nums">
                  {r.growth_24h === null
                    ? <span className="text-moonbeem-ink-subtle">—</span>
                    : (
                      <span
                        className={r.growth_24h >= 0
                          ? "text-emerald-300"
                          : "text-moonbeem-magenta"}
                      >
                        {r.growth_24h >= 0 ? "+" : "-"}
                        {formatMetric(Math.abs(r.growth_24h))}
                      </span>
                    )}
                </td>
                <td className="px-4 py-3 align-middle text-right tabular-nums text-moonbeem-ink">
                  {r.modal_opens.toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
