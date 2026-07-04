// Pure VTT/SRT sanity check (Mux subtitle tracks). Validate by CONTENT SIGNATURE,
// never MIME (File.type for .srt/.vtt is inconsistent — often empty / text/plain).
// The check is a fast-fail UX guard; Mux is the real backstop (a malformed file
// makes the track go status:'errored', surfaced never-silent). Requirements:
//   - non-empty after BOM-strip + trim
//   - VTT: begins with the literal WEBVTT header AND has >=1 dot-ms cue
//   - SRT: no header, >=1 comma-ms cue (the ',' vs '.' ms separator is the
//     reliable VTT/SRT discriminator)

export type SubtitleValidation =
  | { ok: true; format: "vtt" | "srt" }
  | { ok: false; error: string };

// WEBVTT then end-of-string OR whitespace (allows "WEBVTT", "WEBVTT\n", "WEBVTT - x").
const VTT_HEADER = /^WEBVTT(?:[ \t\r\n]|$)/;
// HH:MM:SS.mmm --> HH:MM:SS.mmm  (VTT also allows the MM:SS.mmm short form).
const VTT_CUE = /\d{2}:\d{2}:\d{2}\.\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}\.\d{3}/;
const VTT_CUE_SHORT = /(?:^|\s)\d{2}:\d{2}\.\d{3}\s*-->\s*\d{2}:\d{2}\.\d{3}/;
// HH:MM:SS,mmm --> HH:MM:SS,mmm  (SRT uses a comma).
const SRT_CUE = /\d{2}:\d{2}:\d{2},\d{3}\s*-->\s*\d{2}:\d{2}:\d{2},\d{3}/;

export function validateSubtitle(raw: string): SubtitleValidation {
  if (typeof raw !== "string") return { ok: false, error: "not a text file" };
  const stripped = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw; // strip UTF-8 BOM
  const trimmed = stripped.trimStart();
  if (trimmed.length === 0) return { ok: false, error: "the file is empty" };

  if (VTT_HEADER.test(trimmed)) {
    if (VTT_CUE.test(stripped) || VTT_CUE_SHORT.test(stripped)) {
      return { ok: true, format: "vtt" };
    }
    return {
      ok: false,
      error: "WEBVTT header but no valid cue timings (expected HH:MM:SS.mmm --> HH:MM:SS.mmm)",
    };
  }

  if (SRT_CUE.test(stripped)) return { ok: true, format: "srt" };

  return {
    ok: false,
    error: "not a recognizable WebVTT (.vtt) or SubRip (.srt) subtitle file",
  };
}
