// Unit tests for the pure Source Accounts logic — run with:
//   npx tsx src/lib/source-accounts/normalize.test.ts
//
// No test runner is configured in this repo (see package.json); this is a
// standalone tsx script with a minimal assert harness. It imports normalize.ts
// by RELATIVE path (that module has zero external deps) so no tsconfig path
// resolution is needed. Exits non-zero on any failure.

import {
  normalizeInstagramNode,
  computeIncrementalCursor,
  extractTitleCandidates,
  intOrNullNonNeg,
  type NormalizedPost,
} from "./normalize";

let passed = 0;
let failed = 0;
function ok(cond: boolean, label: string) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`  ✗ FAIL: ${label}`);
  }
}
function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(a === e, `${label} (got ${a}, want ${e})`);
}

// --- fixtures modelled on the real recon payload -------------------------------

// Pinned GraphVideo (docstowatch post #0), out-of-order at the front.
const pinnedVideoNode = {
  __typename: "GraphVideo",
  shortcode: "DT5iYOqgu0r",
  is_video: true,
  product_type: "clips",
  taken_at_timestamp: 1769269959,
  video_view_count: 22424,
  edge_media_preview_like: { count: 593 },
  edge_media_to_comment: { count: 12 },
  like_and_view_counts_disabled: false,
  pinned_for_users: [{ id: "78513464200", username: "docstowatch", is_verified: true }],
  edge_media_to_caption: {
    edges: [
      {
        node: {
          text:
            "Ten documentaries everyone should watch 🙌🎥\n\n" +
            "1. Once Upon a Time in Northern Ireland (James Bluemel, 2023)\n" +
            "2. The Act of Killing (Joshua Oppenheimer, 2012)\n" +
            "3. Grizzly Man (Werner Herzog, 2005)\n\nWhich have you seen?",
        },
      },
    ],
  },
};

// Normal chronological GraphSidecar (carousel), no video views.
const carouselNode = {
  __typename: "GraphSidecar",
  shortcode: "DaIoD4dAumZ",
  is_video: false,
  taken_at_timestamp: 1782660895,
  edge_media_preview_like: { count: 810 },
  like_and_view_counts_disabled: false,
  pinned_for_users: [],
  edge_media_to_caption: { edges: [{ node: { text: "A carousel post with no year." } }] },
};

// Counts hidden -> -1 sentinel must map to null.
const hiddenCountsNode = {
  __typename: "GraphVideo",
  shortcode: "HIDDEN123",
  is_video: true,
  taken_at_timestamp: 1780000000,
  video_view_count: -1,
  edge_media_preview_like: { count: -1 },
  like_and_view_counts_disabled: true,
  pinned_for_users: [],
  edge_media_to_caption: { edges: [] },
};

// --- normalizeInstagramNode ----------------------------------------------------

console.log("normalizeInstagramNode:");
const p0 = normalizeInstagramNode(pinnedVideoNode) as NormalizedPost;
eq(p0.shortcode, "DT5iYOqgu0r", "shortcode");
eq(p0.post_url, "https://www.instagram.com/p/DT5iYOqgu0r/", "post_url");
eq(p0.taken_at, 1769269959, "taken_at");
eq(p0.is_pinned, true, "is_pinned true (pinned_for_users non-empty)");
eq(p0.media_type, "video", "media_type GraphVideo -> video");
eq(p0.video_view_count, 22424, "video_view_count");
eq(p0.like_count, 593, "like_count");
ok(!!p0.caption && p0.caption.includes("Once Upon a Time"), "caption extracted from edge_media_to_caption");

const c0 = normalizeInstagramNode(carouselNode) as NormalizedPost;
eq(c0.media_type, "carousel", "media_type GraphSidecar -> carousel");
eq(c0.video_view_count, null, "video_view_count null for carousel");
eq(c0.is_pinned, false, "is_pinned false (empty pinned_for_users)");

const h0 = normalizeInstagramNode(hiddenCountsNode) as NormalizedPost;
eq(h0.like_count, null, "-1 like_count -> null (like_and_view_counts_disabled)");
eq(h0.video_view_count, null, "-1 video_view_count -> null");

eq(normalizeInstagramNode({ taken_at_timestamp: 1 }), null, "node without shortcode -> null");
eq(intOrNullNonNeg(-1), null, "intOrNullNonNeg(-1) -> null");
eq(intOrNullNonNeg(0), 0, "intOrNullNonNeg(0) -> 0");
eq(intOrNullNonNeg("42"), 42, "intOrNullNonNeg('42') -> 42");

// --- computeIncrementalCursor (the recon flag-3 hazard) ------------------------

console.log("computeIncrementalCursor:");
// Discriminating case: a PINNED post has a NEWER taken_at than every non-pinned
// post. A naive max-over-all (or "first post") would return the pinned ts and
// corrupt the incremental cursor; correct behaviour excludes pinned posts.
const mixed: NormalizedPost[] = [
  { shortcode: "pin", post_url: "", caption: null, taken_at: 9_999_999_999, is_pinned: true, media_type: "video", video_view_count: null, like_count: null },
  { shortcode: "a", post_url: "", caption: null, taken_at: 100, is_pinned: false, media_type: "video", video_view_count: null, like_count: null },
  { shortcode: "b", post_url: "", caption: null, taken_at: 300, is_pinned: false, media_type: "video", video_view_count: null, like_count: null },
  { shortcode: "c", post_url: "", caption: null, taken_at: 200, is_pinned: false, media_type: "video", video_view_count: null, like_count: null },
];
eq(computeIncrementalCursor(mixed), 300, "cursor = max taken_at over NON-pinned (300, not the pinned 9999999999)");
eq(computeIncrementalCursor([mixed[0]]), null, "all-pinned page -> null cursor (never advance on pins alone)");
eq(computeIncrementalCursor([]), null, "empty page -> null cursor");

// --- extractTitleCandidates ----------------------------------------------------

console.log("extractTitleCandidates:");
const cands = extractTitleCandidates(pinnedVideoNode.edge_media_to_caption.edges[0].node.text);
eq(
  cands,
  [
    { name: "Once Upon a Time in Northern Ireland", year: 2023 },
    { name: "The Act of Killing", year: 2012 },
    { name: "Grizzly Man", year: 2005 },
  ],
  "listicle -> clean {name, year} candidates with numbering stripped",
);
eq(extractTitleCandidates("A carousel post with no year."), [], "no parenthetical year -> [] (post lands no_match)");
eq(extractTitleCandidates(null), [], "null caption -> []");
// (YYYY) without director.
eq(
  extractTitleCandidates("My pick is Apollo 11 (2019)"),
  [{ name: "My pick is Apollo 11", year: 2019 }],
  "(YYYY) without director parses (prose lead-in kept — matcher's 0.6 floor filters noise)",
);
// Case-insensitive dedup of a genuine identical repeat (same name + year).
eq(
  extractTitleCandidates(
    "1. Grizzly Man (Werner Herzog, 2005)\n2. GRIZZLY MAN (Werner Herzog, 2005)",
  ),
  [{ name: "Grizzly Man", year: 2005 }],
  "identical title+year (case-insensitive) dedups to one candidate",
);

// --- summary -------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
