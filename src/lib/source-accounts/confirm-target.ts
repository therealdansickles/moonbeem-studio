// Pure decision for confirm-with-override (Review Queue v2, correct-the-title).
//
// The confirm route may receive an optional body { title_id } to override the
// extractor's suggested match. This resolves the EFFECTIVE title the fan_edit gets +
// whether it was an override — with `titleExists` injected so the whole decision is
// unit-testable (the route passes a DB-backed boolean). matched_title_id is NEVER
// mutated by this; the suggestion stays recorded for extractor-quality measurement.

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isWellFormedTitleId(raw: unknown): raw is string {
  return typeof raw === "string" && UUID_RE.test(raw);
}

export type ConfirmTarget =
  | { ok: true; titleId: string; titleOverridden: boolean }
  | { ok: false; error: "invalid_title_id" | "title_not_found" };

// rawTitleId = the optional body.title_id (undefined/null/"" when the reviewer
// confirms as-suggested — the back-compat path). titleExists(id) is called ONLY for
// a well-formed override id. title_overridden is true ONLY when a valid, existing
// override differs from the suggestion.
export function resolveConfirmTarget(
  rawTitleId: unknown,
  matchedTitleId: string,
  titleExists: (id: string) => boolean,
): ConfirmTarget {
  if (rawTitleId == null || rawTitleId === "") {
    return { ok: true, titleId: matchedTitleId, titleOverridden: false };
  }
  if (!isWellFormedTitleId(rawTitleId)) {
    return { ok: false, error: "invalid_title_id" };
  }
  if (!titleExists(rawTitleId)) {
    return { ok: false, error: "title_not_found" };
  }
  return {
    ok: true,
    titleId: rawTitleId,
    titleOverridden: rawTitleId !== matchedTitleId,
  };
}
