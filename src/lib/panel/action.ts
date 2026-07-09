// Action-hint resolver for GET /api/panel/clips/[id]/download. The panel's E.1
// Download-to-disk lane shares the route with Import; ?action= discriminates
// the two in the download_clip telemetry row (metadata.action).
//
// NO imports at all — string comparisons only. That keeps this module runnable
// under `npx tsx` for action.test.ts AND keeps the route's MONEY BOUNDARY
// enumeration ("pure action-hint parser — string comparisons only, zero
// imports") trivially re-verifiable.
//
// Strict exact-match allowlist per ruling: "import" | "download" pass;
// EVERYTHING else — absent (null), empty, wrong case, whitespace, junk —
// resolves to "unspecified" rather than rejecting, so old panel builds (which
// send no hint) keep working unattributed-but-honest. Never guess attribution:
// "IMPORT" is a malformed client, not an import.

export type PanelAction = "import" | "download" | "unspecified";

export function resolveActionHint(raw: string | null): PanelAction {
  if (raw === "import" || raw === "download") return raw;
  return "unspecified";
}
