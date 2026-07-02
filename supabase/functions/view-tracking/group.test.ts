// Fixture tests for the view-tracking post grouping — run with:
//   npx tsx supabase/functions/view-tracking/group.test.ts
// group.ts is Deno-free, so tsx runs it directly.

import { groupFanEditsByPost, type FanEditRow } from "./group";

let passed = 0;
let failed = 0;
function ok(cond: boolean, label: string) {
  if (cond) passed++;
  else {
    failed++;
    console.error(`  ✗ FAIL: ${label}`);
  }
}
function eq(actual: unknown, expected: unknown, label: string) {
  ok(JSON.stringify(actual) === JSON.stringify(expected), `${label} (got ${JSON.stringify(actual)})`);
}

function row(
  id: string,
  post_id: string | null,
  embed_url = "u",
  platform = "instagram",
): FanEditRow {
  return { id, platform, embed_url, post_id };
}

// Core dedup: N rows sharing a post -> ONE group -> ONE fetch, N ids fanned out.
{
  const g = groupFanEditsByPost([row("a", "P1"), row("b", "P1"), row("c", "P1")]);
  eq(g.length, 1, "3 rows same post -> 1 group (1 fetch instead of 3)");
  eq(g[0].ids, ["a", "b", "c"], "all 3 ids fanned into the group");
}

// First-appearance order preserved (FIFO fairness from last_refreshed_at ordering).
{
  const g = groupFanEditsByPost([row("a", "P1"), row("b", "P2"), row("c", "P1")]);
  eq(g.map((x) => x.ids), [["a", "c"], ["b"]], "P1 (first-seen) before P2; c joins P1");
}

// Null post_id falls back to embed_url.
{
  const g = groupFanEditsByPost([
    row("a", null, "url1"),
    row("b", null, "url1"),
    row("c", null, "url2"),
  ]);
  eq(g.map((x) => x.ids), [["a", "b"], ["c"]], "null post_id groups by embed_url");
}

// Platform is part of the key — same post_id on different platforms stays separate.
{
  const g = groupFanEditsByPost([
    row("a", "P1", "u", "instagram"),
    row("b", "P1", "u", "tiktok"),
  ]);
  eq(g.length, 2, "same post_id, different platform -> separate groups");
}

// The group fetches with the FIRST row's embed_url.
{
  const g = groupFanEditsByPost([row("a", "P1", "first"), row("b", "P1", "second")]);
  eq(g[0].embed_url, "first", "group fetch uses the first row's embed_url");
}

// Fetch-reduction: 6 rows across 3 posts -> 3 fetches (was 6).
{
  const g = groupFanEditsByPost([
    row("a", "P1"),
    row("b", "P1"),
    row("c", "P1"),
    row("d", "P2"),
    row("e", "P2"),
    row("f", "P3"),
  ]);
  eq(g.length, 3, "6 rows / 3 posts -> 3 fetches");
  eq(g.reduce((n, x) => n + x.ids.length, 0), 6, "all 6 rows still handled (per-row writes)");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
