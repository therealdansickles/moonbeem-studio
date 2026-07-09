// Fixtures for the panel download action-hint resolver (E.1 telemetry
// discriminator). Pure module (no imports) → tsx runs it directly. Run:
//   npx tsx src/lib/panel/action.test.ts
// Covers the strict allowlist (import|download), and the unspecified fallback
// for absent / empty / wrong-case / whitespace / junk hints — the ruling's
// "unattributed-but-honest" posture for old panel builds.

import { resolveActionHint, type PanelAction } from "./action";

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

// --- allowlist accepted ---
eq(resolveActionHint("import"), "import", 'action=import → "import"');
eq(resolveActionHint("download"), "download", 'action=download → "download"');

// --- absent → unspecified ---
eq(resolveActionHint(null), "unspecified", "action absent (null) → unspecified");
eq(resolveActionHint(""), "unspecified", "action= (empty) → unspecified");

// --- wrong case is junk per ruling, never lowercased into attribution ---
eq(resolveActionHint("IMPORT"), "unspecified", "IMPORT → unspecified");
eq(resolveActionHint("Import"), "unspecified", "Import → unspecified");
eq(resolveActionHint("Download"), "unspecified", "Download → unspecified");
eq(resolveActionHint("DOWNLOAD"), "unspecified", "DOWNLOAD → unspecified");

// --- whitespace/decoding (" import" also covers ?action=+import) ---
eq(resolveActionHint(" import"), "unspecified", '" import" → unspecified');
eq(resolveActionHint("import "), "unspecified", '"import " → unspecified');
eq(resolveActionHint("import\n"), "unspecified", '"import\\n" → unspecified');

// --- junk ---
eq(resolveActionHint("export"), "unspecified", "export → unspecified");
eq(resolveActionHint("downloads"), "unspecified", "downloads (prefix trap) → unspecified");
eq(resolveActionHint("imp"), "unspecified", "imp → unspecified");
eq(resolveActionHint("import,download"), "unspecified", "import,download → unspecified");
eq(resolveActionHint("1"), "unspecified", '"1" → unspecified');

// --- every result is one of the three PanelAction literals ---
const ALL: PanelAction[] = ["import", "download", "unspecified"];
for (const v of [null, "", "import", "download", "IMPORT", "junk"]) {
  ok(ALL.includes(resolveActionHint(v)), `result for ${JSON.stringify(v)} is a PanelAction`);
}

console.log(`\n  ${passed}/${passed + failed} passed${failed ? ` — ${failed} FAILED` : ""}`);
process.exit(failed ? 1 : 0);
