// Pure shaping helpers for GET /api/panel/clips (PANEL_ENDPOINT_SPEC §4-§6).
// NO value imports from `@/…` — only a type-only Clip import (erased at runtime)
// — so this module runs under `npx tsx` for catalog.test.ts. The DB reads and
// the Mux signing live in ./thumbnail.ts and the route; everything here is pure
// and deterministic.

import type { Clip } from "@/lib/queries/titles";

// page: int >= 1, default 1 — the /c/[handle]/followers idiom.
export function parsePage(v: string | null): number {
  return Math.max(1, Number.parseInt(v ?? "1", 10) || 1);
}

// limit: titles per page, clamp 1..50, default 20 (NaN/absent) — the
// /api/admin/titles/search idiom.
export function parseLimit(v: string | null): number {
  const n = Number.parseInt(v ?? "20", 10);
  return Number.isFinite(n) ? Math.min(Math.max(1, n), 50) : 20;
}

// Slice the page and report has_next by the followers idiom: a FULL page
// (=== limit) implies there may be more; a short page is the last. No count
// query. (Spec §5.3 — flips at exactly `limit` items.)
export function paginate<T>(
  list: T[],
  page: number,
  limit: number,
): { pageItems: T[]; hasNext: boolean } {
  const start = (page - 1) * limit;
  const pageItems = list.slice(start, start + limit);
  return { pageItems, hasNext: pageItems.length === limit };
}

// title thumbnail fallback (§6a): muxThumb ?? poster_url ?? null.
export function titleThumbFallback(
  muxThumbUrl: string | null,
  posterUrl: string | null,
): string | null {
  return muxThumbUrl ?? posterUrl ?? null;
}

// q param (§4 amendment, founder-pass item B): trim; empty/whitespace-only →
// null. A null return means the route structurally SKIPS the whole search
// path, so the no-q response stays byte-identical as control flow — not as a
// hoped-for filter identity.
export function normalizeSearchQ(v: string | null): string | null {
  const t = v?.trim() ?? "";
  return t === "" ? null : t;
}

// Catalog search (founder-pass item B, ratified contract): case-insensitive
// LITERAL substring against titles.title OR clips.label, in memory on the
// bounded set — NO DB ILIKE. RIDER 1 (user input matches literally) holds by
// construction: 85 of 176 live labels contain %, _ or \ (filename-style),
// which unescaped ILIKE would corrupt. If this ever moves to DB ILIKE it must
// escape %, _ AND \ — do NOT copy admin/creators/search/route.ts, which
// escapes only % and _.
//
// Name match → "whole" (wins over label matches; all clips). Label-only
// match → the Set of matching clip ids. A title is kept iff whole or its Set
// is non-empty. Input order is preserved. Null labels never match.
export type CatalogSearchClipRow = {
  id: string;
  title_id: string;
  label: string | null;
};

export function applyCatalogSearch<T extends { id: string; title: string }>(
  titles: T[],
  clipRows: CatalogSearchClipRow[],
  q: string,
): { titles: T[]; clipFilter: Map<string, Set<string> | "whole"> } {
  const needle = q.toLowerCase();
  const labelMatchesByTitle = new Map<string, Set<string>>();
  for (const row of clipRows) {
    if (row.label !== null && row.label.toLowerCase().includes(needle)) {
      const set = labelMatchesByTitle.get(row.title_id) ?? new Set<string>();
      set.add(row.id);
      labelMatchesByTitle.set(row.title_id, set);
    }
  }
  const clipFilter = new Map<string, Set<string> | "whole">();
  const kept: T[] = [];
  for (const t of titles) {
    if (t.title.toLowerCase().includes(needle)) {
      clipFilter.set(t.id, "whole");
      kept.push(t);
    } else {
      const set = labelMatchesByTitle.get(t.id);
      if (set && set.size > 0) {
        clipFilter.set(t.id, set);
        kept.push(t);
      }
    }
  }
  return { titles: kept, clipFilter };
}

// The clip entry on the wire: the shared Clip type MINUS file_url and title_id
// (spec §6 — downloads must flow through the traceable download route; title_id
// is redundant under nesting), with thumbnail_url replaced by the composed
// value and the Postgres numeric/bigint columns coerced to JSON numbers.
export type ClipWire = {
  id: string;
  label: string | null;
  duration_seconds: number | null;
  file_size_bytes: number | null;
  content_type: string | null;
  thumbnail_url: string | null;
  display_order: number;
};

// duration_seconds is Postgres `numeric` and file_size_bytes is `bigint`;
// PostgREST serializes both as JSON STRINGS. Coerce to numbers (null-safe) so
// the wire matches §6/§9 and the panel mock. clipThumb = clip.thumbnail_url ??
// titleThumb (§6a); clips.thumbnail_url is NULL on all rows today so clips
// inherit the title value until a per-clip pipeline lands.
export function toClipWire(clip: Clip, titleThumb: string | null): ClipWire {
  return {
    id: clip.id,
    label: clip.label,
    duration_seconds:
      clip.duration_seconds == null ? null : Number(clip.duration_seconds),
    file_size_bytes:
      clip.file_size_bytes == null ? null : Number(clip.file_size_bytes),
    content_type: clip.content_type,
    thumbnail_url: clip.thumbnail_url ?? titleThumb,
    display_order: clip.display_order,
  };
}
