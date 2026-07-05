// Fixtures for the pure download-bundle helpers. Run with:
//   npx tsx src/lib/downloads/bundle.test.ts
import {
  extForContentType,
  filenameForItem,
  dedupeName,
  shouldZipInMemory,
  shouldZipBundle,
  chooseSavePath,
  BUNDLE_ZIP_MAX_BYTES,
} from "./bundle";

let passed = 0;
let failed = 0;
function eq(a: unknown, b: unknown, label: string) {
  if (JSON.stringify(a) === JSON.stringify(b)) passed++;
  else {
    failed++;
    console.error(`  ✗ FAIL: ${label} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
  }
}

console.log("extForContentType:");
eq(extForContentType("video/mp4"), "mp4", "mp4");
eq(extForContentType("video/quicktime"), "mov", "quicktime -> mov");
eq(extForContentType("image/jpeg"), "jpg", "jpeg -> jpg");
eq(extForContentType("image/png"), "png", "png");
eq(extForContentType("image/webp"), "webp", "webp");
eq(extForContentType("IMAGE/JPEG; charset=binary"), "jpg", "cased + parameterized");
eq(extForContentType("application/x-weird"), null, "unknown -> null");
eq(extForContentType(null), null, "null -> null");

console.log("filenameForItem:");
eq(filenameForItem("Opening Scene", "video/mp4", "clip", "mp4"), "Opening Scene.mp4", "label + mp4");
eq(filenameForItem("Behind the scenes / B-roll", "video/quicktime", "clip", "mp4"), "Behind the scenes  B-roll.mov", "strips slash, mov ext");
eq(filenameForItem("", "image/jpeg", "still", "jpg"), "still.jpg", "empty base -> fallbackBase");
eq(filenameForItem(null, "image/png", "still", "jpg"), "still.png", "null base -> fallbackBase, real ext");
eq(filenameForItem("poster.jpg", "image/jpeg", "still", "jpg"), "poster.jpg", "no double extension");
eq(filenameForItem("scene", "application/octet-stream", "clip", "mp4"), "scene.mp4", "unknown type -> fallbackExt");
eq(filenameForItem("émoji 🎬 name", "image/webp", "still", "jpg"), "moji  name.webp", "non-ascii stripped");

console.log("dedupeName:");
{
  const used = new Set<string>();
  eq(dedupeName("a.jpg", used), "a.jpg", "first passes through");
  eq(dedupeName("a.jpg", used), "a-2.jpg", "collision -> -2 before ext");
  eq(dedupeName("a.jpg", used), "a-3.jpg", "second collision -> -3");
  eq(dedupeName("b.png", used), "b.png", "different name passes through");
  eq(dedupeName("noext", used), "noext", "no-ext first passes");
  eq(dedupeName("noext", used), "noext-2", "no-ext collision suffixes at end");
}

console.log("shouldZipInMemory (size branch — both media types, 512 MiB cap):");
const MB = 1024 * 1024;
// boundary
eq(shouldZipInMemory(0), true, "empty -> zip");
eq(shouldZipInMemory(BUNDLE_ZIP_MAX_BYTES), true, "exactly the cap -> zip");
eq(shouldZipInMemory(BUNDLE_ZIP_MAX_BYTES + 1), false, "one over cap -> sequential");
// CLIPS — both directions
eq(shouldZipInMemory(300 * MB), true, "clips: a 300MB set -> zip");
eq(
  shouldZipInMemory(525488587),
  true,
  "clips: Erupcja 525,488,587B (~501MB) -> ZIP at the 512MiB cap (by design)",
);
eq(shouldZipInMemory(2194 * MB), false, "clips: bob-trevino ~2.2GB -> sequential");
// STILLS — both directions
eq(shouldZipInMemory(40 * MB), true, "stills: a 40MB set -> zip");
eq(shouldZipInMemory(595 * MB), false, "stills: dina ~595MB/103 -> sequential");

console.log("shouldZipBundle (iOS short-circuit + device-memory gate + size):");
// iOS (every iOS browser is WebKit) -> ALWAYS sequential, regardless of size or
// deviceMemory (which iOS never reports) — the OOM hotfix.
eq(shouldZipBundle(525488587, undefined, true), false, "iOS + Erupcja ~501MB -> sequential (WebKit OOM guard)");
eq(shouldZipBundle(40 * MB, undefined, true), false, "iOS + tiny 40MB -> sequential (iOS never zips)");
eq(shouldZipBundle(40 * MB, 8, true), false, "iOS + tiny + phantom 8GiB -> sequential (iOS short-circuits FIRST)");
// desktop Safari/Firefox: NOT iOS, absent deviceMemory -> size threshold governs
eq(shouldZipBundle(40 * MB, undefined, false), true, "desktop Safari (no deviceMemory, not iOS) + 40MB -> zip");
eq(shouldZipBundle(525488587, undefined, false), true, "desktop Safari + Erupcja ~501MB -> zip (under 512MiB)");
eq(shouldZipBundle(700 * MB, undefined, false), false, "desktop Safari + 700MB -> sequential (over cap)");
// high-memory Chromium (>4 GiB) -> size threshold governs
eq(shouldZipBundle(525488587, 8, false), true, "8GiB + Erupcja -> zip (size governs)");
eq(shouldZipBundle(700 * MB, 8, false), false, "8GiB + 700MB -> sequential (over cap even on high-mem)");
// low-memory Chromium (<=4 GiB) -> forced sequential regardless of size
eq(shouldZipBundle(525488587, 4, false), false, "4GiB + Erupcja -> sequential (device-memory gate)");
eq(shouldZipBundle(100 * MB, 4, false), false, "4GiB + tiny 100MB -> sequential (gate overrides size)");
eq(shouldZipBundle(100 * MB, 2, false), false, "2GiB + tiny -> sequential");
eq(shouldZipBundle(100 * MB, 6, false), true, "6GiB + tiny -> zip (>4, size governs)");

console.log("chooseSavePath (iOS per-item save):");
eq(chooseSavePath(true, true), "share", "iOS + canShare(files) -> native share sheet");
eq(chooseSavePath(true, false), "anchor", "iOS + no canShare -> single anchor fallback");
eq(chooseSavePath(false, true), "anchor", "desktop/Android (not iOS) -> anchor, UNCHANGED");
eq(chooseSavePath(false, false), "anchor", "desktop, no canShare -> anchor");

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
