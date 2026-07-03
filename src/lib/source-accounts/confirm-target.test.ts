// Route-level decision fixtures for confirm-with-override. Run with:
//   npx tsx src/lib/source-accounts/confirm-target.test.ts
// Pure (titleExists injected), so it covers every branch the confirm route takes,
// including the two 400s, without a DB.

import { resolveConfirmTarget, isWellFormedTitleId } from "./confirm-target";

let passed = 0;
let failed = 0;
function eq(a: unknown, b: unknown, label: string) {
  if (JSON.stringify(a) === JSON.stringify(b)) passed++;
  else {
    failed++;
    console.error(`  ✗ FAIL: ${label} (got ${JSON.stringify(a)})`);
  }
}

const SUGGESTED = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";
const yes = () => true;
const no = () => false;

console.log("confirm-target:");
// 1. empty body -> confirm as suggested (back-compat), flag false, no existence check
eq(
  resolveConfirmTarget(undefined, SUGGESTED, () => {
    throw new Error("titleExists must NOT be called for an empty override");
  }),
  { ok: true, titleId: SUGGESTED, titleOverridden: false },
  "empty (undefined) body -> suggested, flag false",
);
eq(
  resolveConfirmTarget("", SUGGESTED, no),
  { ok: true, titleId: SUGGESTED, titleOverridden: false },
  "empty string body -> suggested, flag false",
);
eq(
  resolveConfirmTarget(null, SUGGESTED, no),
  { ok: true, titleId: SUGGESTED, titleOverridden: false },
  "null body -> suggested, flag false",
);

// 2. valid override, DIFFERENT from suggestion, exists -> override, flag TRUE
eq(
  resolveConfirmTarget(OTHER, SUGGESTED, yes),
  { ok: true, titleId: OTHER, titleOverridden: true },
  "override differs + exists -> override, flag true",
);

// 3. valid override EQUALS the suggestion, exists -> flag FALSE (not a real override)
eq(
  resolveConfirmTarget(SUGGESTED, SUGGESTED, yes),
  { ok: true, titleId: SUGGESTED, titleOverridden: false },
  "override equals suggestion -> flag false",
);

// 4. invalid uuid -> 400 invalid_title_id (existence never checked)
eq(
  resolveConfirmTarget("not-a-uuid", SUGGESTED, () => {
    throw new Error("titleExists must NOT be called for a malformed id");
  }),
  { ok: false, error: "invalid_title_id" },
  "malformed override -> invalid_title_id",
);
eq(
  resolveConfirmTarget(12345, SUGGESTED, no),
  { ok: false, error: "invalid_title_id" },
  "non-string override -> invalid_title_id",
);

// 5. well-formed but not in catalog -> 400 title_not_found
eq(
  resolveConfirmTarget(OTHER, SUGGESTED, no),
  { ok: false, error: "title_not_found" },
  "nonexistent override -> title_not_found",
);

console.log("isWellFormedTitleId:");
eq(isWellFormedTitleId(SUGGESTED), true, "valid uuid");
eq(isWellFormedTitleId("nope"), false, "invalid string");
eq(isWellFormedTitleId(null), false, "null");

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
