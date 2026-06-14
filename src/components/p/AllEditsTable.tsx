"use client";

import { useMemo, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import PlatformIcon from "@/components/PlatformIcon";
import { isR2ThumbnailUrl } from "@/lib/fan-edits/thumbnail-url";
import { useFanEditModal } from "@/components/FanEditModalProvider";
import { formatMetric } from "@/lib/format";

type Row = {
  id: string;
  platform: "tiktok" | "instagram" | "twitter" | "youtube";
  thumbnail_url: string | null;
  title_poster_url: string | null;
  creator_handle: string | null;
  // Modal-compat fields from the /p/[slug] loader.
  embed_url: string;
  creator_handle_displayed: string | null;
  view_count: number;
  growth_24h: number | null;
  modal_opens: number;
};

type Props = {
  rows: Row[];
  titleSlug: string;
  titleName: string;
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

export default function AllEditsTable({ rows, titleSlug, titleName }: Props) {
  const { open } = useFanEditModal();
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

  // Modal-compat list mirrors the user-visible sort so arrow-nav in
  // the modal follows the same ordering as the table.
  const modalList = useMemo(
    () =>
      sorted.map((r) => ({
        id: r.id,
        platform: r.platform,
        embed_url: r.embed_url,
        creator_handle_displayed: r.creator_handle_displayed,
        creator_moonbeem_handle: r.creator_handle,
      })),
    [sorted],
  );

  function openAt(i: number) {
    // track:false suppresses fan_edit_events writes from this admin
    // surface so internal browsing doesn't pollute the partner-
    // visible "Moonbeem plays" count (see Finding 3 audit, 2026-05-10).
    open({
      fanEdits: modalList,
      index: i,
      titleSlug,
      titleName,
      track: false,
    });
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/[0.02]">
      {/* Mobile: scroll-x. Desktop: full width. Vertical scroll
          containment with sticky thead keeps the 81-row table from
          dominating the page. */}
      <div className="overflow-auto max-h-[480px] md:max-h-[640px]">
        <table className="w-full min-w-[640px] border-collapse text-body-sm">
          <thead>
            <tr className="border-b border-white/10 text-left text-caption uppercase tracking-wide text-moonbeem-ink-subtle">
              <th className="sticky top-0 z-10 bg-moonbeem-black px-4 py-3 font-medium">#</th>
              <th className="sticky top-0 z-10 bg-moonbeem-black px-2 py-3 font-medium">Edit</th>
              {HEADERS.map((h) => (
                <th
                  key={h.key}
                  className={`sticky top-0 z-10 bg-moonbeem-black px-4 py-3 font-medium ${
                    h.align === "right" ? "text-right" : "text-left"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => toggleSort(h.key)}
                    className={`group inline-flex items-center gap-1 transition-colors ${
                      sortKey === h.key
                        ? "text-moonbeem-pink"
                        : "text-moonbeem-ink-subtle hover:text-moonbeem-ink"
                    }`}
                  >
                    {h.label}
                    {sortKey === h.key
                      ? (
                        <span aria-hidden="true">
                          {sortDir === "desc" ? "↓" : "↑"}
                        </span>
                      )
                      : (
                        // Inactive sortable: arrow renders dim, then
                        // brightens on header hover so users can see
                        // the column is sortable.
                        <span
                          aria-hidden="true"
                          className="opacity-0 transition-opacity group-hover:opacity-60"
                        >
                          ↓
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
                className="border-b border-white/5 transition-colors hover:bg-gradient-to-r hover:from-moonbeem-violet/[0.08] hover:to-transparent"
              >
                <td className="px-4 py-3 align-middle text-caption tabular-nums text-moonbeem-ink-subtle">
                  {i + 1}
                </td>
                <td className="px-2 py-3 align-middle">
                  <button
                    type="button"
                    onClick={() => openAt(i)}
                    aria-label={`Open fan edit by @${
                      r.creator_handle ?? "anon"
                    }`}
                    className="relative block h-12 w-12 overflow-hidden rounded-lg bg-moonbeem-navy/40 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-moonbeem-pink"
                  >
                    {(() => {
                      // Guard: only an R2-hosted thumbnail is trusted;
                      // null/external/expired urls fall back to the poster.
                      const src =
                        (isR2ThumbnailUrl(r.thumbnail_url)
                          ? r.thumbnail_url
                          : null) ?? r.title_poster_url;
                      return src ? (
                        <Image
                          src={src}
                          alt=""
                          fill
                          sizes="48px"
                          unoptimized
                          className="object-cover"
                        />
                      ) : null;
                    })()}
                  </button>
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
