// Source Accounts — catalog matcher.
//
// Thin wrapper over the match_catalog_titles RPC (trigram against lower(title),
// 0.6 floor, GIN idx_titles_title_trgm — the same proven approach as
// match_letterboxd_films, extended to RETURN the similarity as match_confidence).
// Calls are chunked so a large backfill never trips the ~8s service-role
// statement_timeout: each RPC call carries at most MATCH_CHUNK candidates.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { TitleCandidate } from "./normalize";

export type CatalogMatch = {
  title_id: string;
  slug: string;
  title: string;
  year: number | null;
  is_public: boolean;
  confidence: number;
};

const MATCH_CHUNK = 40;

type RpcRow = {
  idx: number | null;
  title_id: string | null;
  slug: string | null;
  title: string | null;
  year: number | null;
  is_public: boolean | null;
  confidence: number | string | null;
};

// One result per input item (null when nothing cleared the confidence floor),
// preserving input order.
export async function matchCandidates(
  supabase: SupabaseClient,
  items: TitleCandidate[],
  opts?: { threshold?: number },
): Promise<(CatalogMatch | null)[]> {
  const out: (CatalogMatch | null)[] = new Array(items.length).fill(null);
  for (let start = 0; start < items.length; start += MATCH_CHUNK) {
    const chunk = items.slice(start, start + MATCH_CHUNK);
    const args: Record<string, unknown> = {
      items: chunk.map((c) => ({ name: c.name, year: c.year })),
    };
    if (opts?.threshold != null) args.p_threshold = opts.threshold;

    const { data, error } = await supabase.rpc("match_catalog_titles", args);
    if (error) throw new Error(`match_catalog_titles failed: ${error.message}`);

    for (const row of (data ?? []) as RpcRow[]) {
      const localIdx = typeof row.idx === "number" ? row.idx : -1;
      if (localIdx < 0 || localIdx >= chunk.length) continue;
      if (!row.title_id) continue; // no match for this item
      const conf =
        typeof row.confidence === "number" ? row.confidence : Number(row.confidence);
      out[start + localIdx] = {
        title_id: row.title_id,
        slug: row.slug ?? "",
        title: row.title ?? "",
        year: row.year ?? null,
        is_public: row.is_public ?? false,
        confidence: Number.isFinite(conf) ? conf : 0,
      };
    }
  }
  return out;
}

// Default cap on how many distinct titles a single post can queue (a listicle
// can name a lot; ~10 is plenty and bounds review load / fan_edit fan-out).
export const DEFAULT_MATCH_CAP = 10;

// Top-N distinct-title matches per group (per post), in ONE flattened + chunked
// pass — the pipeline's workhorse so a backfill is a handful of RPC calls, not
// one-per-post. For each group: collect matches, dedupe by title_id (two
// candidates can resolve to the same catalog title — keep the higher confidence),
// sort by confidence desc, and cap. Returns an array aligned to `groups`.
export async function topMatchesPerGroup(
  supabase: SupabaseClient,
  groups: TitleCandidate[][],
  opts?: { threshold?: number; cap?: number },
): Promise<CatalogMatch[][]> {
  const cap = opts?.cap ?? DEFAULT_MATCH_CAP;
  const flat: TitleCandidate[] = [];
  const owner: number[] = [];
  groups.forEach((g, gi) => {
    for (const c of g) {
      flat.push(c);
      owner.push(gi);
    }
  });
  const results = await matchCandidates(supabase, flat, { threshold: opts?.threshold });

  // Per group: best match per distinct title_id.
  const byGroup: Map<string, CatalogMatch>[] = groups.map(() => new Map());
  results.forEach((r, i) => {
    if (!r) return;
    const m = byGroup[owner[i]];
    const existing = m.get(r.title_id);
    if (!existing || r.confidence > existing.confidence) m.set(r.title_id, r);
  });

  return byGroup.map((m) =>
    Array.from(m.values())
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, cap),
  );
}
