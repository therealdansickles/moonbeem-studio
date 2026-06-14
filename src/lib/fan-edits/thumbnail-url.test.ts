/* eslint-disable */
// Standalone assertion test for isR2ThumbnailUrl — this repo has no test
// runner configured, so run directly:
//   npx tsx src/lib/fan-edits/thumbnail-url.test.ts
// Proves the non-R2 branch (no non-R2 fan_edit row exists to eyeball
// after the DAlYKM4ODYY backfill, so this is the proof of correctness).
import { isR2ThumbnailUrl } from "./thumbnail-url";

const cases: Array<[string, string | null | undefined, boolean]> = [
  // a pub-...r2.dev URL -> true
  [
    "pub-...r2.dev URL",
    "https://pub-8dcc0cdf788945bc87b3931edd0bb800.r2.dev/fan-edits/thumbnails/instagram-DAlYKM4ODYY.jpg",
    true,
  ],
  // a raw fbcdn/instagram URL -> false
  [
    "raw fbcdn/instagram URL",
    "https://instagram.fcps4-2.fna.fbcdn.net/v/t51.82787-15/x.jpg?oe=6A34CB98",
    false,
  ],
  ["scontent cdninstagram URL", "https://scontent.cdninstagram.com/v/x.jpg", false],
  // null -> false
  ["null", null, false],
  ["undefined", undefined, false],
  // an arbitrary https URL -> false
  ["arbitrary https URL", "https://example.com/whatever.jpg", false],
  // empty string -> false
  ["empty string", "", false],
  ["unparseable string", "not a url", false],
  // any r2.dev subdomain is our public bucket -> true
  ["r2.dev subdomain", "https://anything.r2.dev/key.png", true],
  // lookalike must NOT pass (requires a dot before r2.dev)
  ["lookalike evil-r2.dev", "https://evil-r2.dev/key.png", false],
];

let fails = 0;
for (const [name, input, expected] of cases) {
  const got = isR2ThumbnailUrl(input);
  const pass = got === expected;
  if (!pass) fails++;
  console.log(`${pass ? "PASS" : "FAIL"} ${name} -> ${got} (expected ${expected})`);
}
console.log(`\nRESULT: ${fails === 0 ? "ALL GREEN" : fails + " FAILED"}`);
if (fails > 0) process.exit(1);
