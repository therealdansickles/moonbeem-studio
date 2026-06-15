// Phase 2D.3 — chunked .in() helper.
//
// A single .in(col, ids) over a few hundred uuids builds a multi-KB
// `col=in.(uuid,uuid,…)` query string that exceeds the PostgREST / API-gateway
// URL-length cap and fails the whole request (the "2B trap" — hit at the import
// fuzzy lookup and again at the list poster strips). Where a caller genuinely
// needs EVERY referenced row (a full list, a full diary, the whole active-edit
// set) it can't semantically bound the id set, so it must chunk: ≤100 ids per
// call (the 2B.1 import-worker precedent).
//
// Callback-shaped so each caller keeps its own filters / order / select. The
// caller maps over each chunk's rows itself. Per-chunk errors are logged and
// that chunk degrades to empty — this is for read/display paths where a missing
// batch is cosmetic, NOT for writers that must loud-fail.

const CHUNK = 100;

export async function chunkedIn<T = Record<string, unknown>>(
  ids: string[],
  label: string,
  run: (
    chunk: string[],
  ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const { data, error } = await run(chunk);
    if (error) {
      console.error(
        `[chunked-in] ${label} chunk ${Math.floor(i / CHUNK)} (${chunk.length} ids) failed:`,
        error.message,
      );
      continue;
    }
    if (data) out.push(...data);
  }
  return out;
}

// Loud-fail sibling — for money WRITERS. A failed chunk MUST stop the
// operation. Never degrade to empty (that silently drops rows → over/under-
// credit: e.g. a dropped prior-views batch makes deltaViews = full lifetime
// views → over-credit; a dropped existing-earnings batch flips claimed flags).
// Use chunkedIn ONLY for read/display where a missing row is cosmetic.
//
// Same ≤100-id chunking and callback shape as chunkedIn, but on ANY chunk error
// it THROWS (surfacing the underlying message) instead of logging-and-
// continuing. The throw must be allowed to propagate so the calling write/calc
// aborts and persists nothing — do NOT wrap a chunkedInOrThrow call in a
// catch-and-continue.
export async function chunkedInOrThrow<T = Record<string, unknown>>(
  ids: string[],
  label: string,
  run: (
    chunk: string[],
  ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const { data, error } = await run(chunk);
    if (error) {
      throw new Error(
        `[chunked-in] ${label} chunk ${Math.floor(i / CHUNK)} (${chunk.length} ids) failed: ${error.message}`,
      );
    }
    if (data) out.push(...data);
  }
  return out;
}
