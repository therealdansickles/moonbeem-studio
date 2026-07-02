// Fixture tests for the start_cursor pagination driver — run with:
//   npx tsx src/lib/source-accounts/pagination.test.ts
// No network / no ED units: drainPages is driven by a scripted fake fetchPage.

import { drainPages, parsePostsPage } from "./ensembledata";
import type { NormalizedPost } from "./normalize";

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

function np(code: string): NormalizedPost {
  return {
    shortcode: code,
    post_url: `https://www.instagram.com/p/${code}/`,
    caption: null,
    taken_at: 1,
    is_pinned: false,
    media_type: "video",
    video_view_count: null,
    like_count: null,
  };
}
function page(codes: string[], lastCursor: string | null, rawCount = 153) {
  return { posts: codes.map(np), rawNodeCount: codes.length, rawCount, lastCursor };
}
// Sequential fake: returns scripted[i] on call i, ignoring the cursor value.
function scripted(results: unknown[]) {
  let i = 0;
  return async () => results[i++] as never;
}
function codesOf(posts: NormalizedPost[]) {
  return posts.map((p) => p.shortcode);
}

// Wrapped in main() — tsx transpiles to CJS here, which disallows top-level await.
async function main() {
console.log("drainPages:");

// 1. Drains across pages until last_cursor is null.
{
  const r = await drainPages(scripted([page(["a", "b"], "C1"), page(["c", "d"], null)]), {
    maxCalls: 6,
  });
  if (r.ok) {
    eq(codesOf(r.posts), ["a", "b", "c", "d"], "two pages concatenated");
    eq(r.truncated, false, "fully drained -> not truncated");
    eq(r.calls, 2, "made 2 calls");
    eq(r.rawCount, 153, "rawCount captured from first page");
  } else ok(false, "expected ok drain");
}

// 2. Dedups repeated shortcodes across pages (pinned posts recur).
{
  const r = await drainPages(
    scripted([page(["pin", "a", "b"], "C1"), page(["pin", "c", "d"], null)]),
    { maxCalls: 6 },
  );
  if (r.ok) eq(codesOf(r.posts), ["pin", "a", "b", "c", "d"], "dedup by shortcode across pages");
  else ok(false, "expected ok drain (dedup)");
}

// 3. Hitting the call budget with a cursor still open -> truncated.
{
  const r = await drainPages(
    scripted([page(["a"], "C1"), page(["b"], "C2"), page(["c"], "C3")]),
    { maxCalls: 2 },
  );
  if (r.ok) {
    eq(codesOf(r.posts), ["a", "b"], "stopped at maxCalls");
    eq(r.truncated, true, "cursor still open at cap -> truncated");
    eq(r.calls, 2, "exactly maxCalls calls");
  } else ok(false, "expected ok drain (cap)");
}

// 4. First-page error parks (nothing landed).
{
  const r = await drainPages(scripted([{ ok: false, error: "rate_limited", detail: "429" }]), {
    maxCalls: 6,
  });
  eq(r.ok, false, "first-page error -> EdError");
  if (!r.ok) eq(r.error, "rate_limited", "propagates the ED category");
}

// 5. Later-page error keeps the pages already drained, flags truncated.
{
  const r = await drainPages(
    scripted([page(["a", "b"], "C1"), { ok: false, error: "transient", detail: "x" }]),
    { maxCalls: 6 },
  );
  if (r.ok) {
    eq(codesOf(r.posts), ["a", "b"], "keeps drained page-1 despite page-2 failure");
    eq(r.truncated, true, "later failure -> truncated (more may remain)");
    eq(r.calls, 1, "only the successful call counted");
  } else ok(false, "expected ok (partial drain)");
}

// 6. A page that adds nothing new ends the drain (defensive against a stuck cursor).
{
  const r = await drainPages(scripted([page(["a"], "C1"), page(["a"], "C2")]), { maxCalls: 6 });
  if (r.ok) {
    eq(codesOf(r.posts), ["a"], "no new shortcodes -> stop");
    eq(r.truncated, false, "zero-new stop is a drain, not a truncation");
  } else ok(false, "expected ok (zero-new stop)");
}

console.log("parsePostsPage:");
{
  const good = parsePostsPage({
    data: {
      count: 153,
      last_cursor: "X",
      posts: [{ node: { shortcode: "a", taken_at_timestamp: 1 } }],
    },
  });
  ok("posts" in good, "valid body -> PageOk");
  if ("posts" in good) {
    eq(good.posts[0]?.shortcode, "a", "parses node shortcode");
    eq(good.rawCount, 153, "parses count");
    eq(good.lastCursor, "X", "parses last_cursor");
  }
  const bad = parsePostsPage({ nope: 1 });
  eq("ok" in bad && bad.ok === false, true, "missing data envelope -> EdError");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
}

main();
