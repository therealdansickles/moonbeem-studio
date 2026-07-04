// Fixtures for the pure VTT/SRT validator. Run with:
//   npx tsx src/lib/subtitles/validate.test.ts
import { validateSubtitle } from "./validate";

let passed = 0;
let failed = 0;
function eq(a: unknown, b: unknown, label: string) {
  if (JSON.stringify(a) === JSON.stringify(b)) passed++;
  else {
    failed++;
    console.error(`  ✗ FAIL: ${label} (got ${JSON.stringify(a)})`);
  }
}

const VTT = `WEBVTT

00:00:01.000 --> 00:00:04.000
Hello there.

00:00:05.000 --> 00:00:08.000
Second line.
`;
const VTT_SHORT = `WEBVTT

00:01.000 --> 00:04.000
Short-form timestamps.
`;
const VTT_HEADER_TITLE = `WEBVTT - Some Title

00:00:01.000 --> 00:00:02.000
Cue.
`;
const SRT = `1
00:00:01,000 --> 00:00:04,000
Hello there.

2
00:00:05,000 --> 00:00:08,000
Second line.
`;

console.log("valid direction:");
eq(validateSubtitle(VTT), { ok: true, format: "vtt" }, "standard VTT -> ok vtt");
eq(validateSubtitle(VTT_SHORT), { ok: true, format: "vtt" }, "VTT MM:SS.mmm short form -> ok vtt");
eq(validateSubtitle(VTT_HEADER_TITLE), { ok: true, format: "vtt" }, "WEBVTT - Title header -> ok vtt");
eq(validateSubtitle("﻿" + VTT), { ok: true, format: "vtt" }, "BOM-prefixed VTT -> ok (BOM stripped)");
eq(validateSubtitle(SRT), { ok: true, format: "srt" }, "standard SRT (comma ms) -> ok srt");
eq(validateSubtitle("\n\n" + SRT), { ok: true, format: "srt" }, "SRT with leading blank lines -> ok srt");

console.log("invalid direction:");
eq(validateSubtitle(""), { ok: false, error: "the file is empty" }, "empty -> rejected");
eq(validateSubtitle("   \n  \n"), { ok: false, error: "the file is empty" }, "whitespace-only -> rejected");
eq(
  validateSubtitle("WEBVTT\n\nNo timings here, just prose."),
  { ok: false, error: "WEBVTT header but no valid cue timings (expected HH:MM:SS.mmm --> HH:MM:SS.mmm)" },
  "WEBVTT header but no cues -> rejected",
);
eq(
  validateSubtitle("Just some random text file, not subtitles at all."),
  { ok: false, error: "not a recognizable WebVTT (.vtt) or SubRip (.srt) subtitle file" },
  "arbitrary text -> rejected",
);
eq(
  validateSubtitle("WEBVTTgarbage\n00:00:01.000 --> 00:00:02.000\nx"),
  { ok: false, error: "not a recognizable WebVTT (.vtt) or SubRip (.srt) subtitle file" },
  "WEBVTT-with-no-boundary is not a real header -> rejected",
);
// a VTT-style dot-ms file WITHOUT the WEBVTT header is not valid VTT and not SRT (no comma) -> rejected
eq(
  validateSubtitle("00:00:01.000 --> 00:00:04.000\nHeaderless dot-ms."),
  { ok: false, error: "not a recognizable WebVTT (.vtt) or SubRip (.srt) subtitle file" },
  "dot-ms cue but no WEBVTT header -> rejected",
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
