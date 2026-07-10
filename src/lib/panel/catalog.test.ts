// Fixtures for the panel catalog shaping helpers (PANEL_ENDPOINT_SPEC §4-§6,
// §9). Pure module (no DB/network/signing) → tsx runs it directly. Run:
//   npx tsx src/lib/panel/catalog.test.ts
// Covers the param clamps, has_next boundary, clip-wire shaping (strip
// file_url/title_id, coerce numeric/bigint → JSON number, clipThumb fallback),
// and the §10 assertion: the re-hosted erupcja title resolves to the R2 JPEG and
// NO webp/squarespace value reaches the wire.

import type { Clip } from "@/lib/queries/titles";
import {
  parsePage,
  parseLimit,
  paginate,
  titleThumbFallback,
  toClipWire,
  normalizeSearchQ,
  applyCatalogSearch,
  type CatalogSearchClipRow,
  type ClipWire,
} from "./catalog";

let passed = 0;
let failed = 0;
function ok(cond: boolean, label: string) {
  if (cond) passed++;
  else {
    failed++;
    console.error(`  ✗ FAIL: ${label}`);
  }
}
function eq(a: unknown, b: unknown, label: string) {
  ok(JSON.stringify(a) === JSON.stringify(b), `${label} (got ${JSON.stringify(a)})`);
}

// --- param clamps (§4/§9) ---
eq(parsePage("0"), 1, "page=0 → 1");
eq(parsePage("abc"), 1, "page=abc → 1");
eq(parsePage(null), 1, "page absent → 1");
eq(parsePage("3"), 3, "page=3 → 3");
eq(parseLimit("0"), 1, "limit=0 → 1");
eq(parseLimit("-1"), 1, "limit=-1 → 1");
eq(parseLimit("9999"), 50, "limit=9999 → 50");
eq(parseLimit("NaN"), 20, "limit=NaN → 20");
eq(parseLimit(null), 20, "limit absent → 20");
eq(parseLimit("50"), 50, "limit=50 → 50");
eq(parseLimit("51"), 50, "limit=51 → 50");

// --- pagination + has_next boundary (§5.3 — flips at exactly limit) ---
const list23 = Array.from({ length: 23 }, (_, i) => i);
const p1 = paginate(list23, 1, 20);
eq(p1.pageItems.length, 20, "23 titles, page 1, limit 20 → 20 items");
ok(p1.hasNext === true, "23/page1 → has_next true");
const p2 = paginate(list23, 2, 20);
eq(p2.pageItems.length, 3, "23 titles, page 2 → 3 items");
ok(p2.hasNext === false, "23/page2 → has_next false");
const exact = paginate(Array.from({ length: 20 }, (_, i) => i), 1, 20);
ok(exact.hasNext === true, "exactly-limit page → has_next true (followers idiom)");
const empty = paginate([], 1, 20);
ok(empty.hasNext === false, "empty list → has_next false");
const past = paginate(list23, 99, 20);
eq(past.pageItems.length, 0, "page past end → 0 items");
ok(past.hasNext === false, "page past end → has_next false");

// --- title thumbnail fallback (§6a) ---
eq(titleThumbFallback("mux://t", "poster"), "mux://t", "mux wins over poster");
eq(titleThumbFallback(null, "poster"), "poster", "poster when no mux");
eq(titleThumbFallback(null, null), null, "null when neither");

// --- clip wire shaping (§6/§9): strip file_url+title_id, coerce numeric/bigint ---
// PostgREST returns numeric (duration_seconds) and bigint (file_size_bytes) as
// STRINGS — the fixture uses strings to prove coercion.
const rawClip = {
  id: "clip-1",
  title_id: "title-1",
  file_url: "https://r2/clip.mp4",
  thumbnail_url: null,
  label: "videoplayback (3)",
  duration_seconds: "21.92",
  file_size_bytes: "966419",
  content_type: "video/mp4",
  display_order: 0,
} as unknown as Clip;

const wire = toClipWire(rawClip, "https://title-thumb");
ok(!("file_url" in wire), "wire drops file_url");
ok(!("title_id" in wire), "wire drops title_id");
eq(wire.duration_seconds, 21.92, "duration_seconds string → JSON number");
ok(typeof wire.duration_seconds === "number", "duration_seconds is a number type");
eq(wire.file_size_bytes, 966419, "file_size_bytes bigint-string → JSON number");
ok(typeof wire.file_size_bytes === "number", "file_size_bytes is a number type");
eq(wire.thumbnail_url, "https://title-thumb", "clip inherits title thumb when clips.thumbnail_url NULL");

// per-clip thumbnail wins when present
const wire2 = toClipWire(
  { ...rawClip, thumbnail_url: "https://clip-thumb" } as unknown as Clip,
  "https://title-thumb",
);
eq(wire2.thumbnail_url, "https://clip-thumb", "clip.thumbnail_url wins over title thumb");

// null numeric stays null (not 0)
const wire3 = toClipWire(
  { ...rawClip, duration_seconds: null, file_size_bytes: null } as unknown as Clip,
  null,
);
eq(wire3.duration_seconds, null, "null duration_seconds stays null (not 0)");
eq(wire3.file_size_bytes, null, "null file_size_bytes stays null (not 0)");

// --- §10: re-hosted erupcja resolves to R2 JPEG; NO webp/squarespace on the wire ---
const ERUPCJA_R2 =
  "https://pub-8dcc0cdf788945bc87b3931edd0bb800.r2.dev/posters/erupcja/1783443082259.jpg";
const erupcjaThumb = titleThumbFallback(null, ERUPCJA_R2); // no Mux episode → poster
eq(erupcjaThumb, ERUPCJA_R2, "§10: erupcja composed thumbnail = R2 JPEG");
ok(erupcjaThumb!.endsWith(".jpg"), "§10: erupcja thumbnail is a .jpg");
const sampleWire: ClipWire[] = [toClipWire(rawClip, erupcjaThumb)];
const serialized = JSON.stringify({ thumbnail_url: erupcjaThumb, clips: sampleWire });
ok(!/squarespace/i.test(serialized), "§10: no 'squarespace' anywhere on the wire");
ok(!/webp/i.test(serialized), "§10: no 'webp' anywhere on the wire");

// --- q search (§4 amendment, founder-pass item B) ---

// normalizeSearchQ: absent/empty/whitespace → null (route skips the filter path)
eq(normalizeSearchQ(null), null, "q absent → null");
eq(normalizeSearchQ(""), null, "q empty → null");
eq(normalizeSearchQ("   "), null, "q whitespace-only → null");
eq(normalizeSearchQ(" erupcja "), "erupcja", "q trims outer whitespace");
eq(normalizeSearchQ("a b"), "a b", "interior whitespace preserved");

// applyCatalogSearch fixture — labels deliberately carry _, %, \ (85 of 176
// live labels contain ILIKE-special characters; literal matching is the
// contract, RIDER 1).
const sT1 = { id: "t1", title: "Erupcja" };
const sT2 = { id: "t2", title: "Videoplayback Collection" };
const sT3 = { id: "t3", title: "Zebra_Film 100%" };
const sTitles = [sT1, sT2, sT3];
const sClips: CatalogSearchClipRow[] = [
  { id: "c1", title_id: "t1", label: "opening_scene_01" },
  { id: "c2", title_id: "t1", label: "eruption wide" },
  { id: "c3", title_id: "t2", label: "beach day" },
  { id: "c4", title_id: "t2", label: "Erupcja cameo" },
  { id: "c5", title_id: "t3", label: null },
  { id: "c6", title_id: "t3", label: "dir\\cut v2" },
];

const rERUP = applyCatalogSearch(sTitles, sClips, "ERUP");
eq(rERUP.titles.map((t) => t.id), ["t1", "t2"], "q=ERUP → [t1 (name), t2 (label)] in input order");
eq(rERUP.clipFilter.get("t1"), "whole", "name match → whole (wins over t1's own label match)");
ok(rERUP.clipFilter.get("t2") instanceof Set, "label-only match → Set");
eq(Array.from(rERUP.clipFilter.get("t2") as Set<string>), ["c4"], "t2 Set is exactly {c4} (excludes c3)");

eq(applyCatalogSearch(sTitles, sClips, "zzz").titles, [], "no match → titles []");

// RIDER 1 contract artifacts: ILIKE-special characters match LITERALLY
eq(applyCatalogSearch(sTitles, sClips, "100%").titles.map((t) => t.id), ["t3"], 'q="100%" literal → t3 by name');
eq(applyCatalogSearch(sTitles, sClips, "1000%").titles, [], 'q="1000%" → no match (% is not a wildcard)');
const rUnder = applyCatalogSearch(sTitles, sClips, "_");
eq(rUnder.titles.map((t) => t.id), ["t1", "t3"], 'q="_" matches only underscore-bearers (NOT everything — the unescaped-ILIKE failure mode, inverted); order preserved past the t2 gap');
eq(Array.from(rUnder.clipFilter.get("t1") as Set<string>), ["c1"], 'q="_" → t1 via Set{c1}');
eq(rUnder.clipFilter.get("t3"), "whole", 'q="_" → t3 whole (name has _)');
const rBack = applyCatalogSearch(sTitles, sClips, "\\");
eq(rBack.titles.map((t) => t.id), ["t3"], 'q="\\" literal backslash → t3 via label');
eq(Array.from(rBack.clipFilter.get("t3") as Set<string>), ["c6"], "backslash Set is {c6}; null label c5 never matches, never throws");

// case-insensitive both directions + mid-string
eq(applyCatalogSearch(sTitles, sClips, "VIDEOPLAYBACK").clipFilter.get("t2"), "whole", "uppercase q matches title name");
eq(Array.from(applyCatalogSearch(sTitles, sClips, "CAMEO").clipFilter.get("t2") as Set<string>), ["c4"], "uppercase q matches label");
eq(applyCatalogSearch(sTitles, sClips, "upcj").clipFilter.get("t1"), "whole", "mid-string match (not prefix-anchored)");

// pagination composes AFTER filtering
const sMany = Array.from({ length: 23 }, (_, i) => ({ id: `m${i}`, title: `Match ${i}` }));
const rMany = applyCatalogSearch(sMany, [], "match");
const sp1 = paginate(rMany.titles, 1, 20);
ok(sp1.pageItems.length === 20 && sp1.hasNext === true, "23 matches page 1 → 20 + has_next");
const sp2 = paginate(rMany.titles, 2, 20);
ok(sp2.pageItems.length === 3 && sp2.hasNext === false, "23 matches page 2 → 3 + no next");

console.log(`\n  ${passed}/${passed + failed} passed${failed ? ` — ${failed} FAILED` : ""}`);
process.exit(failed ? 1 : 0);
