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

function np(
  code: string,
  opts: { taken_at?: number; is_pinned?: boolean } = {},
): NormalizedPost {
  return {
    shortcode: code,
    post_url: `https://www.instagram.com/p/${code}/`,
    caption: null,
    taken_at: opts.taken_at ?? 1,
    is_pinned: opts.is_pinned ?? false,
    media_type: "video",
    video_view_count: null,
    like_count: null,
  };
}
function page(codes: string[], lastCursor: string | null, rawCount = 153) {
  return { posts: codes.map((c) => np(c)), rawNodeCount: codes.length, rawCount, lastCursor };
}
// A page built from explicit posts (for taken_at / is_pinned-sensitive cursor tests).
function pageP(posts: NormalizedPost[], lastCursor: string | null, rawCount = 153) {
  return { posts, rawNodeCount: posts.length, rawCount, lastCursor };
}
// Incremental stop discriminator (mirrors the pipeline): a fetched NON-PINNED post
// has reached back to (<=) the cursor.
function reached(cursor: number) {
  return (posts: NormalizedPost[]) =>
    posts.some((p) => !p.is_pinned && p.taken_at != null && p.taken_at <= cursor);
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

console.log("drainPages — incremental cursor-aware stop (cursor=100):");

// A. Typical week: page 1 already reaches the cursor -> 1 call, not truncated.
{
  const r = await drainPages(
    scripted([
      pageP(
        [
          np("pin", { taken_at: 50, is_pinned: true }),
          np("new", { taken_at: 130 }),
          np("cur", { taken_at: 100 }),
        ],
        "C1",
      ),
    ]),
    { maxCalls: 3, reachedCursor: reached(100) },
  );
  if (r.ok) {
    eq(r.calls, 1, "typical: single call");
    eq(r.truncated, false, "typical: caught up -> not truncated");
  } else ok(false, "typical: expected ok");
}

// B. Burst within cap: catches up on page 2 -> 2 calls, clean.
{
  const r = await drainPages(
    scripted([
      pageP([np("a", { taken_at: 130 }), np("b", { taken_at: 120 })], "C1"),
      pageP([np("c", { taken_at: 110 }), np("d", { taken_at: 90 })], "C2"),
    ]),
    { maxCalls: 3, reachedCursor: reached(100) },
  );
  if (r.ok) {
    eq(r.calls, 2, "burst-within-cap: 2 calls");
    eq(r.truncated, false, "burst-within-cap: reached cursor -> not truncated");
  } else ok(false, "burst-within-cap: expected ok");
}

// C. Burst beyond cap: never reaches the cursor in 3 calls -> truncated (cursor held).
{
  const r = await drainPages(
    scripted([
      pageP([np("a", { taken_at: 130 })], "C1"),
      pageP([np("b", { taken_at: 120 })], "C2"),
      pageP([np("c", { taken_at: 110 })], "C3"),
    ]),
    { maxCalls: 3, reachedCursor: reached(100) },
  );
  if (r.ok) {
    eq(r.calls, 3, "burst-beyond-cap: hit the cap");
    eq(r.truncated, true, "burst-beyond-cap: new posts may remain -> truncated");
  } else ok(false, "burst-beyond-cap: expected ok");
}

// D. Pins never false-trigger the stop: an old pinned post on page 1 does NOT count
//    as reaching the cursor; the real cursor is only reached on page 2.
{
  const r = await drainPages(
    scripted([
      pageP([np("pin", { taken_at: 50, is_pinned: true }), np("a", { taken_at: 130 })], "C1"),
      pageP([np("b", { taken_at: 90 })], "C2"),
    ]),
    { maxCalls: 3, reachedCursor: reached(100) },
  );
  if (r.ok) {
    eq(r.calls, 2, "pin-exclusion: pin(50) did not stop page 1; reached on page 2");
    eq(r.truncated, false, "pin-exclusion: not truncated");
  } else ok(false, "pin-exclusion: expected ok");
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
