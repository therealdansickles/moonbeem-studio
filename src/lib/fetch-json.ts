// Client-side fetch wrapper that turns HTTP failures into structured
// errors, with first-class handling for rate-limit 429s introduced by
// the Stage 1-5 enforcement rollout.
//
// Usage:
//   try {
//     const data = await fetchJson<MyResponse>("/api/me/profile", {
//       method: "POST", body: { ... },
//     });
//   } catch (err) {
//     if (err instanceof RateLimitedError) {
//       toast(`Slow down a moment. Try again in ${err.retryAfter}s.`);
//       return;
//     }
//     if (err instanceof FetchJsonError) {
//       toast(err.userMessage);
//       return;
//     }
//     throw err;
//   }

export class FetchJsonError extends Error {
  status: number;
  /** A user-safe message suitable for direct UI display. */
  userMessage: string;
  /** The raw server payload, if any. */
  payload: unknown;

  constructor(status: number, userMessage: string, payload: unknown) {
    super(`fetchJson ${status}: ${userMessage}`);
    this.name = "FetchJsonError";
    this.status = status;
    this.userMessage = userMessage;
    this.payload = payload;
  }
}

export class RateLimitedError extends FetchJsonError {
  /** Seconds until the limit resets, from the server's Retry-After header. */
  retryAfter: number;

  constructor(retryAfter: number, payload: unknown) {
    super(
      429,
      retryAfter > 0
        ? `Slow down a moment. Try again in ${retryAfter}s.`
        : "Slow down a moment. Try again shortly.",
      payload,
    );
    this.name = "RateLimitedError";
    this.retryAfter = retryAfter;
  }
}

type FetchJsonOptions = Omit<RequestInit, "body"> & {
  /** Auto-stringified as JSON; sets Content-Type when body is non-null. */
  body?: unknown;
};

export async function fetchJson<T = unknown>(
  url: string,
  options: FetchJsonOptions = {},
): Promise<T> {
  const { body, headers, ...rest } = options;
  const init: RequestInit = { ...rest };
  if (body !== undefined && body !== null) {
    init.body = typeof body === "string" ? body : JSON.stringify(body);
    init.headers = {
      "Content-Type": "application/json",
      ...(headers as Record<string, string> | undefined),
    };
  } else if (headers) {
    init.headers = headers;
  }

  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (networkErr) {
    throw new FetchJsonError(
      0,
      "Network problem. Check your connection and try again.",
      networkErr instanceof Error ? networkErr.message : String(networkErr),
    );
  }

  // Try to read JSON; tolerate empty/non-JSON bodies.
  let payload: unknown = null;
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    payload = await res.json().catch(() => null);
  } else {
    const text = await res.text().catch(() => "");
    payload = text || null;
  }

  if (res.ok) {
    return payload as T;
  }

  if (res.status === 429) {
    const retryAfterHeader = res.headers.get("retry-after");
    const retryAfter = retryAfterHeader ? Number(retryAfterHeader) : 0;
    throw new RateLimitedError(
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 0,
      payload,
    );
  }

  if (res.status === 401) {
    throw new FetchJsonError(401, "Sign in to continue.", payload);
  }

  if (res.status === 403) {
    throw new FetchJsonError(403, "You don't have access to that.", payload);
  }

  if (res.status === 404) {
    throw new FetchJsonError(404, "Couldn't find that.", payload);
  }

  if (res.status >= 500) {
    throw new FetchJsonError(
      res.status,
      "Something went wrong on our end. Try again in a moment.",
      payload,
    );
  }

  // 4xx other than the above — surface server's own error message
  // when present, otherwise a generic.
  const serverMsg = extractServerMessage(payload);
  throw new FetchJsonError(
    res.status,
    serverMsg ?? "Couldn't complete that request.",
    payload,
  );
}

function extractServerMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const obj = payload as Record<string, unknown>;
  if (typeof obj.error === "string" && obj.error.length > 0) {
    // Server errors are mostly machine-readable codes (e.g. "slug_taken",
    // "invalid_handle"). Surface a humanized form rather than the raw
    // snake_case.
    return humanizeServerError(obj.error);
  }
  return null;
}

const HUMAN: Record<string, string> = {
  slug_taken: "That URL is already in use.",
  invalid_handle: "That handle isn't valid.",
  handle_taken: "That handle is already taken.",
  not_authorized: "You don't have access to that.",
  not_authenticated: "Sign in to continue.",
  invalid_json: "Couldn't read that input.",
  partner_not_found: "Couldn't find that partner.",
  title_not_found: "Couldn't find that title.",
  user_not_found: "Couldn't find that user.",
  public_requires_active: "Make it active before going public.",
  titles_attached: "Detach this partner's titles first.",
};

function humanizeServerError(code: string): string {
  if (HUMAN[code]) return HUMAN[code];
  // Fall back to converting snake_case to sentence: "no_fields" → "No fields"
  const sentence = code
    .replace(/_/g, " ")
    .replace(/^./, (c) => c.toUpperCase());
  return sentence + ".";
}
