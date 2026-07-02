// Group due fan_edits by the same underlying post so view-tracking fetches
// EnsembleData ONCE per post and fans the identical stats out to every row that
// shares it. Before this, N fan_edits sharing one post (a Source Accounts listicle
// confirmed to N titles → N rows with the same embed_url) triggered N identical ED
// fetches per refresh cycle — an N× spend on the shared token plus N wasted slots of
// the per-invocation budget. Grouping turns N fetches → 1; the per-row writes are
// unchanged (each fan_edit still gets its own snapshot + counter update), so stored
// values are byte-identical to the per-row path (equivalence, not a behavior change).
//
// Pure + Deno-free so it can be unit-tested with tsx.

export type FanEditRow = {
  id: string;
  platform: string;
  embed_url: string;
  post_id: string | null;
};

export type PostGroup = {
  platform: string;
  embed_url: string; // the embed_url to fetch with (first row's — all resolve to the same post)
  ids: string[]; // every fan_edit id sharing this post
};

// Key = platform + post_id (the canonical "same post" id; robust to URL variants),
// falling back to embed_url when post_id is null. Groups preserve first-appearance
// order so the last_refreshed_at ASC ordering (FIFO fairness) carries through.
export function groupFanEditsByPost(rows: FanEditRow[]): PostGroup[] {
  const order: string[] = [];
  const byKey = new Map<string, PostGroup>();
  for (const r of rows) {
    const key = `${r.platform}::${r.post_id ?? r.embed_url}`;
    let g = byKey.get(key);
    if (!g) {
      g = { platform: r.platform, embed_url: r.embed_url, ids: [] };
      byKey.set(key, g);
      order.push(key);
    }
    g.ids.push(r.id);
  }
  return order.map((k) => byKey.get(k) as PostGroup);
}
